# PROVABLE_P2 — Clerk + Self-Serve Onboarding (LOCKED REFERENCE)

**Status:** P1 (Security & Tenancy, S1–S4) DONE and live on prod. This is the P2 spec.
**Goal of P2:** make *any* organization able to sign up and use Provable — human auth (Clerk),
first-login org provisioning, the 3-screen onboarding with a show-once API key, the Settings/rotate
page, empty states, and replacing the transitional single server-side dashboard key with per-user
Clerk-org context.
**Out of scope:** billing, pricing, plan-gating. Every org gets all features.

---

## 0. Standing invariants (must hold every sub-phase)

1. **Two-tenant isolation smoke stays green.** Atlas (Customer #1) and a second org ("Beta Corp")
   stay fully isolated. After P2 this smoke must also cover the *human/web* path, not just machine keys.
2. **No billing / no plan-gating** anywhere in the product.
3. **Live/destructive ops are run by Rohith** in the terminal, watching each result — prisma
   migrate/deploy, git push, Render env-var changes, key rotation, smokes. Claude Code does file/code
   edits only. Every prompt below is tagged **[CC]** (Claude Code) or **[ROHITH]** (you run it).
4. **The live demo must stay intact** throughout. Atlas data and the refund-desk integration keep working.
5. **API stays Clerk-agnostic.** Only `apps/web` knows about Clerk. The API authenticates by
   (a) per-org machine key (hashed, from P1) or (b) the internal service token — never a Clerk session.

---

## 1. Design decisions (LOCKED)

**D1 — Tenant = Clerk Organization.** Each Provable `Org` maps 1:1 to a Clerk Organization via a new
`clerkOrgId` column. A freshly signed-up user has *no* active org until onboarding screen 1 creates one;
that is what "first-login org provisioning" means in practice.

**D2 — Just-in-time (JIT) provisioning, not webhooks (for now).** On any authenticated request whose
active Clerk org has no matching Provable `Org`, provision it synchronously (idempotent upsert on
`clerkOrgId`). Avoids the webhook race (dashboard loading before `organization.created` fires).
Webhooks are a later hardening option, not P2.

**D3 — Web→API auth = internal service token + `x-provable-org-id` (THE consequential one).**
P1 hashed API keys at rest, so the web tier *cannot* retrieve an org's plaintext key to call the API.
Replacement:
- `apps/web` (server-only) holds `PROVABLE_INTERNAL_TOKEN` (high-entropy shared secret, same trust
  level as today's transitional key, never shipped to the browser).
- Per request, the web server resolves `orgId` from the Clerk session (`await auth()`), maps
  `clerkOrgId → Provable Org`, and calls the API with
  `Authorization: Bearer <PROVABLE_INTERNAL_TOKEN>` + `x-provable-org-id: <provableOrgId>`.
- The API gains an internal-auth branch that trusts the token and sets `req.org` from the supplied
  orgId — then flows through the **same P1 tenant-guard** as before.
- Strictly more isolated than today (today = always Atlas; now = scoped to the logged-in user's org).
- The org id is **server-derived from a Clerk-verified session**, never from client input
  (defense-in-depth re: CVE-2025-29927 — middleware alone is not the trust boundary; the data layer is).

**D4 — Control-plane ops live in web server actions; data reads go through the API.**
- *Provision* and *rotate* are infrequent control-plane writes naturally owned by the trusted web/onboarding
  tier → implement as **server actions in `apps/web` using `packages/db` directly** (Clerk-authed,
  orgId from `auth()`). No new API endpoint needed; no internal token needed for these.
- *Dashboard data reads* (`/agents`, `/agents/:id`, `/alerts`, `/roi`, `/tokens`, `/audit`) keep going
  through `apps/api` over HTTP, now with the D3 internal-token path.
- **Hard rule:** server actions always derive the target org from `auth().orgId → clerkOrgId`,
  **never** from a client-supplied id. (No cross-tenant write surface.)

**D5 — Show-once key; provisioning idempotent; rotate is the recovery path.**
- Key generation reuses P1's `generateApiKey()` / `hashApiKey()`. We store `apiKeyHash` + `apiKeyPrefix`
  only; the plaintext is returned by the provisioning action **exactly once** and never retrievable again.
- `provisionOrg({ clerkOrgId, name })` outcomes: **created** → returns plaintext once; **existing** →
  returns the org with **no** plaintext (JIT re-runs hit this and never re-show a key).
- If a user loses the key (closes the tab on screen 2), recovery = **Settings → Rotate** (generates a
  fresh key, shows once, old key dies immediately because the hash changed).

**D6 — Consolidate the duplicated key module now.** P2 touches key generation (provision + rotate), so
collapse `apps/api/src/lib/apiKey.ts` and `packages/db/src/apiKey.ts` into **one source**
(`packages/db`) and import from it everywhere. Prevents the drift flagged in P1.

---

## 2. Schema delta

```prisma
model Org {
  // ...existing P1 fields: id, name, apiKeyHash, apiKeyPrefix, createdAt...
  clerkOrgId String? @unique   // null only for legacy/unlinked rows; backfilled for Atlas + Beta
}
```

Migration: additive, nullable+unique, **deploys clean from an empty DB** (keep the baselined P1 chain
intact — append a new migration, do not rewrite history).
Backfill: Atlas and Beta Corp get linked to real Clerk orgs in **C6** (you create those Clerk orgs).

---

## 3. Sub-phases (gated). Do not advance until the gate is green.

### C1 — Provisioning core + internal-auth branch (no UI) **[CC build / ROHITH migrate]**
- Add `clerkOrgId` to `Org`; new migration.
- Consolidate the apiKey module (D6).
- `provisionOrg({ clerkOrgId, name })` in `packages/db` — idempotent upsert on `clerkOrgId`; on create,
  generate key and return `{ org, plaintextKey }`; on existing, return `{ org, plaintextKey: null }`.
- `rotateKey({ orgId })` in `packages/db` — generate new key, update hash+prefix, return plaintext once.
- API auth middleware: add internal branch. Order: **internal token first**, else machine-key (P1), else
  401. Internal branch validates `PROVABLE_INTERNAL_TOKEN`, looks up org by `x-provable-org-id`, sets
  `req.org`, flows through the tenant-guard. Missing/invalid token or unknown org → 401.
- Scope internal token to dashboard **read** endpoints; ingestion (`/track*`, gateway) stays machine-key-only.
- Unit tests: provision idempotency (second call returns null plaintext, same key prefix); rotate kills old
  key; internal branch resolves + scopes; bad token → 401.

**Gate C1:** `prisma migrate deploy` clean from empty DB ✓ · provision idempotent ✓ · rotate invalidates
old key ✓ · internal-token path returns only the supplied org's data, bad token → 401 ✓ ·
**existing P1 machine-key smoke still green** ✓.

**[CC] prompt:**
> In the provable monorepo, implement P2-C1 per PROVABLE_P2_CLERK_ONBOARDING.md §3 C1. (1) Add nullable
> unique `clerkOrgId` to the `Org` model and create one additive migration (do not alter the existing
> baselined chain). (2) Consolidate `apps/api/src/lib/apiKey.ts` and `packages/db/src/apiKey.ts` into a
> single module in `packages/db`; update all imports. (3) Add `provisionOrg` and `rotateKey` to
> `packages/db` exactly per D4/D5/D6 (idempotent upsert; plaintext returned once on create, null on
> existing; rotate returns plaintext once). (4) In the API auth middleware add an internal-auth branch:
> check `PROVABLE_INTERNAL_TOKEN` Bearer first, resolve org from `x-provable-org-id`, set `req.org`,
> keep it flowing through the existing tenant-guard; fall back to the P1 machine-key path; else 401.
> Internal branch is allowed only on the dashboard read routes; `/track*` and gateway stay machine-key
> only. (5) Add Jest+Supertest tests for all four behaviors in the gate. Do not run migrations or touch
> Render — leave those for me. Report the new migration filename and the exact env vars I need to set.

**[ROHITH] after C1 merges:** set `PROVABLE_INTERNAL_TOKEN` on `provable-api` (Render). Run
`prisma migrate deploy` on a **Neon branch** first, verify, then prod. Re-run the P1 machine-key smoke.

---

### C2 — Clerk wired into web + JIT provisioning **[CC build / ROHITH env+Clerk dashboard]**
- Install `@clerk/nextjs`. Wrap `apps/web` root layout in `<ClerkProvider>`.
- Middleware (`middleware.ts` for Next 14/15, **`proxy.ts` for Next 16** — match the installed version):
  `clerkMiddleware` + `createRouteMatcher`; protect all dashboard routes, leave `/`, `/sign-in`,
  `/sign-up`, `/onboarding` public; `await auth.protect()` on protected routes.
- **Confirm Next.js is ≥ 14.2.25 / 15.2.3** (CVE-2025-29927). If older, bump first.
- Sign-in / sign-up pages (Clerk components or hosted).
- Server helper `getActiveOrg()`: `const { userId, orgId } = await auth()`; if `orgId` is set but no
  Provable Org exists for it → call `provisionOrg` (JIT, idempotent) and return it; if `orgId` is null →
  signal "needs onboarding". Never trust a client-supplied org id (D4).

**Gate C2:** unauthenticated hitting a dashboard route → redirected to sign-in ✓ · authed user with an
active Clerk org → Provable Org exists (JIT-provisioned) ✓ · authed user with no active org → routed to
onboarding ✓ · `orgId` available in RSC ✓.

**[CC] prompt:**
> Implement P2-C2 per §3 C2. Add `@clerk/nextjs` to `apps/web`, wrap the root layout in `ClerkProvider`,
> add Clerk middleware using the current Core-3 App Router pattern (`clerkMiddleware` +
> `createRouteMatcher`, `await auth.protect()`), using `middleware.ts` or `proxy.ts` to match our Next
> version — and confirm/raise Next.js to a CVE-2025-29927-patched version. Add `/sign-in` and `/sign-up`.
> Add `lib/getActiveOrg()` that reads `await auth()`, JIT-provisions via `provisionOrg` when an active
> Clerk org has no Provable Org, and signals "needs onboarding" when there's no active org. Do not touch
> Render or the Clerk dashboard — list every env var and every Clerk-dashboard setting I must configure.

**[ROHITH] before/after C2:** in the **Clerk dashboard** create a prod instance, **enable Organizations**,
set sign-in/up + redirect URLs for the `onrender.com` domains. On `provable-web` (Render) set
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (and matching sign-in/up URL envs).

---

### C3 — Swap the transitional dashboard key for per-user org context **[CC build / ROHITH env]**
- Rewrite `apps/web/lib/api.ts`: drop `PROVABLE_API_KEY`. Per request (server-side) resolve the active
  org via `getActiveOrg()`, then call the API with `Authorization: Bearer <PROVABLE_INTERNAL_TOKEN>` +
  `x-provable-org-id: <provableOrgId>`. Token stays server-only (RSC / server actions), never in the browser.
- All six read endpoints now scoped to the logged-in user's org.

**Gate C3 (this is the isolation gate):** user in Clerk-org A sees only A's data; user in B sees only B's ✓ ·
removing the old `PROVABLE_API_KEY` from `provable-web` does **not** break authorized reads ✓ ·
**Beta Corp isolation green via the web path** ✓.

**[CC] prompt:**
> Implement P2-C3 per §3 C3. Rewrite `apps/web/lib/api.ts` to stop using the shared `PROVABLE_API_KEY`
> and instead resolve the active org per request via `getActiveOrg()` and call the API with the internal
> token + `x-provable-org-id`. Keep the token strictly server-side. Update all six dashboard read calls.
> Do not remove any Render env var yourself — tell me which one to delete after I verify.

**[ROHITH] after C3 verified:** delete the now-dead `PROVABLE_API_KEY` from `provable-web`. Run the
two-tenant smoke via the web path.

---

### C4 — 3-screen onboarding + show-once key **[CC build]**
- Route `/onboarding`, reached when the user has no active org (or has an org but no Provable Org yet).
- **Screen 1 — Workspace:** org name input → client `createOrganization({ name })` then
  `setActive({ organization })` (so the session has `orgId`) → call server action `provisionAndIssueKey()`
  which reads `auth().orgId`, runs `provisionOrg`, returns the plaintext **once**.
- **Screen 2 — API key (show once):** render the plaintext key, copy button, a clear "we can't show this
  again — store it in your secret manager" warning, and a pre-filled SDK snippet using the key.
- **Screen 3 — Connect first agent:** the `provable.track()` quickstart + "go to dashboard". Landing
  shows empty states (C5).
- Refreshing/returning never re-shows the key (provision returns null plaintext on existing — D5).

**Gate C4:** brand-new user end-to-end (sign up → name workspace → see key once → land on empty
dashboard) ✓ · refresh on screen 2 does **not** re-show the key ✓ · lost-key path = Settings→Rotate ✓.

**[CC] prompt:**
> Implement P2-C4 per §3 C4: a 3-screen `/onboarding` flow. Screen 1 creates the Clerk org client-side
> (`createOrganization` + `setActive`) then calls a `provisionAndIssueKey` server action that reads
> `auth().orgId`, runs `provisionOrg`, and returns the plaintext key once. Screen 2 shows the key once
> with a copy button, a "stored once / can't be shown again" warning, and a filled SDK snippet. Screen 3
> is the `provable.track()` quickstart + a button to the dashboard. Use shadcn/ui + Tailwind, match the
> existing dashboard styling. Never re-display the key on refresh or return.

---

### C5 — Settings / rotate page + empty states **[CC build]**
- `/settings`: org name, `apiKeyPrefix` (e.g. `pk_live_abc…`), **Rotate key** button → server action
  `rotateKey({ orgId: auth-derived })` → show-once modal with the new key + a danger warning that existing
  integrations break until updated. Org id derived from `auth()`, never client input (D4).
- Empty states across all six dashboard pages for a fresh org: "No agents yet — install the SDK and send
  your first event," linking to the quickstart / Settings (where they can rotate to get a key if lost).

**Gate C5:** rotate → old key returns 401 at the API, new key works ✓ · empty states render for a fresh
org and disappear once events arrive ✓.

**[CC] prompt:**
> Implement P2-C5 per §3 C5: a `/settings` page (org name, key prefix, Rotate button → `rotateKey` server
> action with org derived from `auth()`, show-once modal, danger warning) and empty states on all six
> dashboard pages pointing to the SDK quickstart. shadcn/ui + Tailwind, matching existing styling.

---

### C6 — Atlas/Beta backfill, smoke update, prod cutover **[CC smoke / ROHITH live ops]**
- **[CC]** update the two-tenant isolation smoke to exercise the **web/Clerk path**: org A session sees
  only A; org B sees only B; internal-token + `x-provable-org-id=A` returns only A, `=B` only B; plus the
  existing machine-key isolation stays asserted.
- **[ROHITH]** create Clerk orgs for Atlas + Beta; backfill their `clerkOrgId`; confirm you can log in and
  see Atlas data; confirm refund-desk (machine key) still works unchanged.
- **[ROHITH]** prod cutover: Neon branch rehearsal + snapshot first → `prisma migrate deploy` → set/verify
  all Render env vars → push → run the updated smoke → confirm the live demo is intact.

**Gate C6 (phase exit):** updated two-tenant smoke green on prod ✓ · Atlas login shows Atlas data ✓ ·
refund-desk ingestion unchanged ✓ · a brand-new throwaway Clerk signup can self-serve onboard into a
clean isolated org ✓.

---

## 4. Env / Clerk-dashboard config (ROHITH)

**Clerk dashboard:** prod instance · **Organizations enabled** · sign-in/up + redirect URLs for
`provable-web.onrender.com`.

**Render — `provable-web`:** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
Clerk sign-in/up URL envs, `PROVABLE_INTERNAL_TOKEN`. Remove `PROVABLE_API_KEY` after C3 verified.
**Render — `provable-api`:** `PROVABLE_INTERNAL_TOKEN` (same value as web).
Reminder: `DATABASE_URL` stays the **direct** (non-pooled) Neon string for migrations.

---

## 5. Risk / rollback notes

- **Internal token leak** = ability to impersonate any org by id. Mitigation: server-only, high-entropy,
  rotatable; never logged; not accepted on ingestion routes. Treat like the P1 provider-key hygiene.
- **JIT race** on first request: idempotent upsert on `clerkOrgId` makes concurrent provisions safe
  (last-write-wins on a no-op).
- **Lost show-once key**: by design — recovery is Rotate, not retrieval. Make the screen-2 warning loud.
- **Migration**: additive + nullable, so rollback = leave the column; no destructive change. Rehearse on a
  Neon branch (S4 pattern) before prod.
- **Demo integrity**: Atlas keeps its machine key for refund-desk; C6 only *adds* a `clerkOrgId` link so
  you can also log in as Atlas. Nothing about the deterministic demo beats changes.

---

## 6. Phase exit definition

P2 is done when: any new user can sign up → name a workspace → receive a show-once key → land on an empty,
isolated dashboard; the dashboard renders per the logged-in user's org (no shared key anywhere); Settings
can rotate the key; and the updated two-tenant smoke is green on prod with the live demo intact.
**Next:** P4 (ingestion hardening) — and fold in the parked P4 items (denormalize `orgId` onto
Event/Task, `groupBy` in the tenant-guard set, ioredis/BullMQ typecheck fixes, rolling-24h `callsToday`,
zod + idempotent eventId + `/track/batch` + debounced recompute + indexes).
