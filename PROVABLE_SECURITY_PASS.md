# PROVABLE — Security & Tenancy Pass (Locked Spec)

**Status:** Ready to execute. Next pass after gateway ship.
**Scope:** Real generated API keys · hashed at rest · org isolation · provider keys never stored.
**Constraint that shapes everything:** Atlas Insurance is **live on Render** and `refund-desk` carries the key in its env. This pass must migrate the live demo without breaking it.

> Working rule for this doc: this is the single source of truth. Claude Code follows the phases in order, stops at each acceptance gate, and does not refactor outside the named files.

---

## 1. Objective

Move Provable from "demo-grade auth" to "defensible multi-tenant auth" without changing the product surface or breaking the live Atlas demo.

Four things must become true:

1. **Keys are generated, not hardcoded.** No literal key constant anywhere in source or seed.
2. **Keys are unrecoverable from the DB.** The database stores a hash + a display prefix, never a usable key.
3. **Tenants cannot see each other's data.** Every Agent/Task/Event/cost query is scoped to the authenticated org. There is no code path that returns another org's rows.
4. **Provider keys are pass-through only.** The customer's Anthropic key rides the gateway request through to Anthropic and is never written to the DB, the queue, or any log line.

Non-goals for this pass (explicitly deferred, do not build):
- Per-org rate limiting
- Key scopes / least-privilege key permissions
- SSO / Clerk-side org provisioning changes
- UI for key management beyond "show once on create + rotate"

---

## 2. Current state → target state

| Concern | Current | Target |
|---|---|---|
| Key storage | `Org.apiKey` plaintext, hardcoded `<atlas-key-rotated-out>` | `Org.apiKeyHash` (unique, indexed) + `Org.apiKeyPrefix` (display only). No plaintext key in DB. |
| Key creation | Seed constant | `generateApiKey()` at org creation; full key returned **once**, never re-readable |
| Auth check | string equality on `x-provable-key` | sha256(incoming) → `findUnique({ apiKeyHash })`; 401 on miss |
| Tenant scoping | org resolved, but trust handler discipline | `req.org` set by middleware; mandatory `orgId` filter enforced + a guard that fails loudly if a query forgets it |
| Provider key (gateway) | forwarded to Anthropic | forwarded to Anthropic, **stripped before any logging/capture**, never persisted |

---

## 3. Prisma schema changes

In `packages/db` (or wherever `schema.prisma` lives):

```prisma
model Org {
  id           String   @id @default(cuid())
  name         String
  // REMOVE: apiKey String @unique
  apiKeyHash   String   @unique           // sha256 hex of the full key
  apiKeyPrefix String                     // e.g. "pk_live_a1b2c3d4" — for display only
  apiKeyRotatedAt DateTime @default(now())
  // ...existing relations (agents, tasks, events) unchanged
}
```

Notes:
- `apiKeyHash` is the lookup key. Exact-match on an indexed unique column is a single index hit and is constant-time-safe because the input is high-entropy — no separate constant-time compare needed.
- `apiKeyPrefix` is the only key-derived value safe to show in the dashboard (`pk_live_a1b2c3d4…`).
- Generate one migration. Do **not** squash existing migrations.

---

## 4. Key module — `packages/sdk` or `apps/api/src/lib/apiKey.ts`

Single home for generation + hashing so the API and any tooling agree.

```ts
import { randomBytes, createHash } from "node:crypto";

const PREFIX = "pk_live_";

/** Returns the full key (show once) plus the values to persist. */
export function generateApiKey() {
  const secret = randomBytes(24).toString("base64url"); // 192 bits, URL-safe
  const fullKey = `${PREFIX}${secret}`;
  return {
    fullKey,                                  // return to user ONCE, never store
    apiKeyHash: hashApiKey(fullKey),          // store this
    apiKeyPrefix: fullKey.slice(0, PREFIX.length + 8), // store this, for display
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
```

Rationale for sha256 over bcrypt/argon2 here: API keys are full-entropy random secrets, so the slow-hash protection that passwords need doesn't apply, and this hash runs on every request. Fast deterministic hash + unique-index lookup is the right call and is the industry norm.

---

## 5. Auth middleware rewrite — `apps/api/src/middleware/auth.ts`

Current middleware does string equality. Replace with hash lookup that sets `req.org`.

```ts
export async function requireOrg(req, reply) {
  const presented = req.headers["x-provable-key"];
  if (typeof presented !== "string" || !presented.startsWith("pk_live_")) {
    return reply.code(401).send({ error: "missing_or_malformed_key" });
  }
  const org = await prisma.org.findUnique({
    where: { apiKeyHash: hashApiKey(presented) },
  });
  if (!org) return reply.code(401).send({ error: "invalid_key" });
  req.org = org;            // every downstream handler reads req.org.id
}
```

- The 401 messages must be identical-shape regardless of *why* it failed beyond the malformed-vs-invalid split, so a caller can't probe which keys exist.
- `x-provable-agent` (agent-by-name) resolution stays as-is but must now resolve **within `req.org.id`** (see §6).

---

## 6. Org isolation enforcement

Two layers — a discipline layer and a guard layer.

**Discipline layer:** every handler that touches Agent / Task / Event / cost rows filters by `req.org.id`. Agent-by-name lookups become:

```ts
const agent = await prisma.agent.findFirst({
  where: { orgId: req.org.id, name: presentedAgentName },
});
```

Never `findUnique({ name })` — name is only unique *within* an org.

**Guard layer:** add a Prisma client extension (or a thin repo wrapper) that throws if a query against a tenant-scoped model is issued without an `orgId` in the where clause. This catches the next forgotten filter at runtime instead of in a breach.

```ts
// packages/db/src/tenantGuard.ts — applied via prisma.$extends
const TENANT_MODELS = new Set(["Agent", "Task", "Event"]);
// in query extension: if TENANT_MODELS.has(model) and no orgId key present
// in args.where -> throw new Error(`tenant scope missing on ${model}.${operation}`)
```

Acceptance for this section is behavioral: a request with Org A's key must return **zero** of Org B's agents/tasks/events, verified by a test that seeds two orgs and cross-queries.

---

## 7. Provider-key handling (gateway) — `apps/gateway`

The gateway proxies `/v1/messages` to Anthropic. The customer's Anthropic key arrives in the request and must:

- Be forwarded **unchanged** to `api.anthropic.com`.
- Never be written to the DB (the capture/`tee()` path records tokens/cost/latency — never the auth header).
- Never appear in a log line, an error object, or the BullMQ job payload.

Concretely:
1. Before any `console.log` / structured log of the request, build a sanitized copy that omits `authorization`, `x-api-key`, and `x-provable-key`.
2. The cost-capture object persisted to Postgres contains only: `orgId`, `agentId`, `tokensIn`, `tokensOut`, `costUsd`, `latencyMs`, `model`. Assert no header material is on it.
3. Add a test that fires a proxied call with a sentinel fake key and greps the DB rows + captured logs for the sentinel — it must not appear.

---

## 8. Migration plan — protect the live Atlas demo

This is the part that bites in a live demo. Sequence matters.

1. Run the schema migration (adds `apiKeyHash`/`apiKeyPrefix`, drops `apiKey`).
2. **Backfill Atlas:** generate a real key for the existing Atlas org, write its hash + prefix, capture the full key from stdout **once**.
3. **Re-point `refund-desk`:** update the `PROVABLE_API_KEY` env var on the `refund-desk` Render service to the new full key. Redeploy.
4. Smoke: submit one refund through refund-desk → confirm `track()` lands on the new key → confirm the decision scores and shows in the dashboard.
5. Only then delete any reference to `<atlas-key-rotated-out>` from source.

Do **not** delete the old constant before step 4 passes. If the smoke fails, the old key is the rollback path.

Write the backfill as a one-shot script (`scripts/migrate-atlas-key.mjs`) that prints the new key and the exact Render env update to make — don't do it by hand.

---

## 9. Phased Claude Code prompts

Run in order. Stop at each gate. Paste output back before proceeding.

### Phase S1 — Schema + key module (no behavior change yet)
> Add `apiKeyHash` (unique) and `apiKeyPrefix` to the `Org` model and remove `apiKey`. Create one Prisma migration. Create `apps/api/src/lib/apiKey.ts` with `generateApiKey()` and `hashApiKey()` exactly as specified in PROVABLE_SECURITY_PASS.md §4. Do not touch the auth middleware or seed yet. Output the migration SQL and the new file.
>
> **Gate:** migration compiles, `apiKey` column gone, key module exports both functions.

### Phase S2 — Auth middleware + isolation guard
> Rewrite `apps/api/src/middleware/auth.ts` to resolve the org by `hashApiKey(presented)` per §5, setting `req.org`. Update all agent-by-name lookups to `findFirst({ where: { orgId: req.org.id, name } })` per §6. Add the tenant guard Prisma extension per §6 covering Agent, Task, Event. Do not change the gateway. Output every changed handler.
>
> **Gate:** a test seeding Org A + Org B proves Org A's key returns none of Org B's agents/tasks/events, and a query missing `orgId` throws.

### Phase S3 — Gateway provider-key hygiene
> In `apps/gateway`, ensure the inbound Anthropic key is forwarded unchanged but excluded from every log line and from the persisted cost-capture object per §7. Add a sentinel-key test that asserts the fake key appears in neither the DB rows nor captured logs. Do not change proxy behavior or cost math.
>
> **Gate:** sentinel test passes; proxied call still returns Anthropic's response byte-for-byte.

### Phase S4 — Migrate Atlas, then purge the constant
> Create `scripts/migrate-atlas-key.mjs` that finds the Atlas org, generates a real key, writes hash + prefix, and prints (a) the full key once and (b) the exact `refund-desk` Render env var to set. Do NOT delete the hardcoded `<atlas-key-rotated-out>` constant yet. Output the script.
>
> **Gate (manual, in order):** run script → update refund-desk env on Render → redeploy → submit one refund → confirm it scores in the dashboard. Only after that passes: remove the old constant from source in a separate commit.

---

## 10. Acceptance checklist (whole pass)

- [ ] No plaintext key, and no `<atlas-key-rotated-out>`, anywhere in source or seed
- [ ] DB stores only `apiKeyHash` + `apiKeyPrefix`; full key irrecoverable
- [ ] New org → key shown once, works on next request, never re-readable
- [ ] Invalid key → 401; valid key → scoped `req.org`
- [ ] Org A key returns zero Org B rows (test-proven)
- [ ] Forgotten `orgId` filter throws at runtime (guard test)
- [ ] Provider key forwarded unchanged, absent from DB + logs (sentinel test)
- [ ] Atlas migrated live; refund-desk re-pointed; one refund scores end-to-end
- [ ] Old constant deleted only after live smoke passed

---

## 11. After this pass

Next in the pending queue (unchanged):
1. Gateway UI page — stat cards + cost-by-agent + live feed
2. Self-hosting packaging — Docker Compose + Helm
3. Rolling-24h fix for `callsToday`
