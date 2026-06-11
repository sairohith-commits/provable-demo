# Provable — Phase 10: Organizational Adoption (Build Spec)

> **Purpose.** Show how a real organization adopts Provable: an AI agent that lives in **its own separate repository**, installs `@provable/sdk` like any npm package, points at the org's self-hosted Provable instance, and — with three lines of code — **enrolls itself and appears in the Provable dashboard**, governed, accruing a readiness score from real work.
>
> **The shift from Phase 9.** Phase 9's agents lived inside the Provable monorepo and tracked by internal database IDs. No real customer knows those IDs or imports Provable's workspace packages. This phase makes integration authentic: external repo, real package install, self-enrollment, and track-by-name.
>
> **Prereq.** Phases 1–9 complete. Hand this file to Claude Code.

---

## 0. The adoption story this must support

1. Provable is running, self-hosted. The org's registry does **not** yet contain the new agent.
2. In a **separate** repo, a developer installs `@provable/sdk`, adds ~3 lines (init → register → track), and points it at the org's Provable URL with an org API key.
3. They run their agent. It does real support-triage work via Claude and tracks each decision.
4. Back in Provable, a refresh shows the agent **now present**, scored per task, with real cost and an audit trail — no manual database setup anywhere.

The hero beat: "We `npm install`'d the SDK, wrote three lines, and the agent is now governed."

---

## 1. Provable-side changes (enable self-enrollment)

### Schema (`packages/db`)
- `Org`: add `apiKey String @unique` (demo-grade key, e.g. `pk_live_<slug>`). The structure seed generates one and **prints it** for the external repo's `.env`.
- `Task`: add `key String` (stable slug like `set_priority`) and make it unique per agent (`@@unique([agentId, key])`). Agents/tasks are now addressable by name/key, not cuid.

### API (`apps/api`)
Auth: read the org API key from header `x-provable-key` on `/register` and `/track`; resolve the org. Reject unknown keys with 401.

- **`POST /register`** — body `{ agent: string, purpose?: string, tasks: [{ key, name, riskLevel }] }`. Upsert the agent by `(orgId, name)`; upsert each task by `(agentId, key)`. Idempotent — safe to call on every startup. Returns `{ ok: true }`.
- **`POST /track`** — header `x-provable-agent: <name>` + body `{ task: <key>, outcome, confidence, wasOverridden, wasEscalated, latencyMs?, tokens?, metadata? }`. Resolve org (from key) → agent (by name) → task (by key, **upsert if unseen**), create the `Event`, enqueue the recompute job. No internal IDs ever cross the wire.

The existing BullMQ worker, scoring engine, and dashboard are unchanged — a newly enrolled agent appears in `GET /agents` automatically.

---

## 2. SDK changes (`packages/sdk`)

Customer-facing DX — no IDs, names only:

```ts
import { Provable } from "@provable/sdk";

const provable = new Provable({
  apiUrl: process.env.PROVABLE_API_URL!,   // the org's self-hosted instance
  apiKey: process.env.PROVABLE_API_KEY!,   // org key
  agent: "Support Triage Agent",           // this agent's identity
});

// once, on startup — idempotent
await provable.register({
  purpose: "Triages inbound support tickets",
  tasks: [
    { key: "classify_category",     name: "Classify ticket category", riskLevel: "low" },
    { key: "set_priority",          name: "Set priority",             riskLevel: "medium" },
    { key: "auto_resolve_decision", name: "Auto-resolve or escalate", riskLevel: "high" },
    { key: "detect_duplicate",      name: "Detect duplicate ticket",  riskLevel: "medium" },
  ],
});

// per decision
await provable.track({
  task: "set_priority",
  outcome: "success",
  confidence: 0.82,
  wasOverridden: false,
  wasEscalated: false,
  tokens, latencyMs,
  metadata: { ticketId, answer, reasoning },
});
```

The SDK attaches `x-provable-key` and `x-provable-agent` to every request. `track()` takes a task **key**, never an ID.

---

## 3. SDK distribution (install it like a real customer)

- In `packages/sdk`: ensure `package.json` has correct `main`/`types`/`files`, then `npm pack` → produces `provable-sdk-<version>.tgz`.
- The external repo installs **that tarball**: `npm install /abs/path/to/provable-sdk-<version>.tgz`. This is the exact artifact a customer would `npm install`.
- Fallback for iteration: `"@provable/sdk": "file:../provable/packages/sdk"` in the external repo's package.json. Use the tarball for the actual demo — it's the authentic story.

---

## 4. The external agent repo (NEW — outside the monorepo)

Create `support-triage-agent/` as a **standalone** project (not in the Provable workspace):

```
support-triage-agent/
├─ package.json          # deps: @provable/sdk (tarball), @anthropic-ai/sdk, tsx
├─ .env                  # PROVABLE_API_URL, PROVABLE_API_KEY, ANTHROPIC_API_KEY, models
├─ data/tickets.json     # ~90 labeled support tickets, difficulty-tiered per task
└─ src/
   ├─ provable.ts        # SDK init + register()
   ├─ worker.ts          # real Claude calls per task; judges outcome vs label; captures tokens+latency
   ├─ reviewer.ts        # second Claude call → genuine overrides
   └─ run.ts             # onboard | live | runaway
```

Behavior mirrors Phase 9's worker/reviewer pattern (real model calls, outcome judged against labels, escalation by confidence threshold, real tokens/latency), but it's a self-contained app consuming Provable purely through the published SDK.

Tasks are difficulty-tiered so earned scores separate into bands (tune **inputs only**, never outcomes):
- `classify_category` — easy → Solo
- `set_priority` — medium → Co-Pilot
- `auto_resolve_decision` — ambiguous + strict reviewer → Shadow
- `detect_duplicate` — small volume → Co-Pilot, primed for the live crossing

Commands (in the external repo):
- `npm run onboard` — `register()` then process the full labeled set. The agent appears in Provable and earns its scores.
- `npm run live` — register + a small fresh batch on `detect_duplicate` → visible recompute on stage.
- `npm run runaway` — a deliberately broken/verbose prompt → real token spike → Provable's RUNAWAY_COST alert.

---

## 5. Dashboard (`apps/web`) — minimal addition

The new agent already renders via `GET /agents`. Add only:
- An **"Enrolled <relative time>"** label on the agent card (from the agent's `createdAt`).
- A subtle **live** indicator when the agent has events in the last few minutes (so the room sees it's active).

Nothing else changes.

---

## 6. The adoption demo flow

1. Provable running; open the registry — the Support Triage Agent is **absent**.
2. Switch to the `support-triage-agent` repo. Show `package.json` (the SDK is a normal dependency) and `src/provable.ts` — the ~3 lines: init, `register()`, `track()`.
3. Run `npm run onboard`. Tickets stream through real Claude calls; each decision is tracked.
4. Switch back to Provable, refresh the registry — **the agent is now there**, "Enrolled just now," scores populating per task.
5. Open it: earned readiness bands, real cost/ROI, and an audit trail of a real decision with the reviewer's override.
6. Optional live beat: `npm run live` → `detect_duplicate` crosses into Solo from real decisions.

Narration anchor: "Their data never left their infrastructure. They installed a package and wrote three lines. That's the whole adoption cost."

---

## 7. Acceptance criteria — "org adoption ready when"

- The agent repo lives **outside** the Provable monorepo and depends on `@provable/sdk` via the **packed tarball** (no workspace import).
- With only `PROVABLE_API_URL`, `PROVABLE_API_KEY`, and an agent name configured, `npm run onboard` **creates the agent and its tasks in Provable automatically** and emits real events — zero manual DB work.
- `track()` and `register()` reference agents/tasks by **name/key only**; no internal cuid IDs appear in the external code.
- After onboarding, the agent appears in the dashboard with distinct earned bands per task, real token cost, and a real audit trail.
- `npm run live` produces a visible live recompute; `npm run runaway` produces a real RUNAWAY_COST alert.
- An unknown/missing API key is rejected (401).

---

## 8. Scope / notes

- The org API key is demo-grade (single org, stored plain, not rotated/hashed) — enough to prove the enrollment model, not production auth. Note this to the room only if asked.
- Keep the labeled ticket set small enough that a full onboard costs cents (Haiku worker).
- Do not change the scoring formula, the recompute path, or the existing seeded demo. This phase is additive and reuses all of it.
