# Provable — Demo Build Spec (Claude Code Master Prompt)

> **Purpose.** Build a fully working, self-contained demo of Provable: a seeded backend, a readiness-scoring engine, an event SDK, and an executive dashboard that tells the **Atlas Insurance** story end to end. This is a *demo build*, not the full product — auth is stubbed, multi-tenancy is single-org, and only the screens needed for the run-of-show are built.
>
> **How to use this file.** Hand it to Claude Code at the root of a fresh repo. Execute the phases in order. Each phase ends with an acceptance check — do not move on until it passes.

---

## 0. The story this demo must tell

A mid-size P&C insurer ("Atlas Insurance") deployed AI agents into claims operations six months ago. They work — but Atlas has no governance layer. The demo proves Provable supplies that layer across three beats:

1. **Task-level readiness** — one agent, three tasks, three different verdicts (Solo / Co-Pilot / Shadow). This is the core principle: readiness is task-level, never blanket per-agent.
2. **Cost governance** — a tokenmaxxing anomaly was caught and capped (the Microsoft/Uber problem, with a happy ending).
3. **ROI + defensibility** — cost-per-outcome, hours saved, ROI score, and an immutable audit trail for a denied claim.

Tagline to surface in the UI header: *"IBM proved agents work. Provable makes them governable."*

---

## 1. Tech stack (locked — do not substitute)

- **Monorepo:** Turborepo + pnpm workspaces
- **Frontend:** Next.js (App Router) + Tailwind + shadcn/ui, **light theme**, `recharts` for charts
- **Backend:** Node.js + Fastify + BullMQ + Redis
- **DB:** PostgreSQL + Prisma
- **Local dev:** Docker Compose (Postgres + Redis)
- **SDK:** `@provable/sdk` (TypeScript), exposing `provable.track()`
- **Language:** TypeScript everywhere
- **Auth:** stubbed — single hardcoded org, no Clerk for the demo

---

## 2. Repo structure

```
provable-demo/
├─ docker-compose.yml          # postgres + redis
├─ turbo.json
├─ package.json                # pnpm workspaces root
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ web/                     # Next.js dashboard
│  └─ api/                     # Fastify API + BullMQ worker
└─ packages/
   ├─ db/                      # Prisma schema, client, seed script
   └─ sdk/                     # @provable/sdk
```

---

## 3. Phase 1 — Scaffold & infra

1. Init pnpm workspace + Turborepo with the structure above.
2. Write `docker-compose.yml` exposing Postgres (`5432`) and Redis (`6379`) with named volumes.
3. Add a root `.env` consumed by `packages/db` and `apps/api`:
   ```
   DATABASE_URL="postgresql://provable:provable@localhost:5432/provable"
   REDIS_URL="redis://localhost:6379"
   API_PORT=4000
   ```
4. Root scripts: `pnpm dev` (turbo runs web + api), `pnpm db:push`, `pnpm db:seed`, `pnpm infra:up` (docker compose up -d).

**Acceptance:** `pnpm infra:up` brings up Postgres + Redis; `pnpm dev` starts web on `:3000` and api on `:4000` with no errors.

---

## 4. Phase 2 — Database (`packages/db`)

Prisma schema. Tables: `orgs`, `agents`, `tasks`, `events`, `scores`, `policies`, `alerts`.

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Mode      { SHADOW COPILOT SOLO }
enum Outcome   { SUCCESS FAILURE PARTIAL }
enum AlertType { RUNAWAY_COST COMPLIANCE READINESS_DROP ANOMALY }

model Org {
  id        String   @id @default(cuid())
  name      String
  agents    Agent[]
  createdAt DateTime @default(now())
}

model Agent {
  id        String   @id @default(cuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id])
  name      String
  purpose   String
  tasks     Task[]
  events    Event[]
  alerts    Alert[]
  createdAt DateTime @default(now())
}

model Task {
  id        String   @id @default(cuid())
  agentId   String
  agent     Agent    @relation(fields: [agentId], references: [id])
  name      String
  riskLevel String   // "low" | "medium" | "high"
  events    Event[]
  scores    Score[]
  createdAt DateTime @default(now())
}

model Event {
  id            String   @id @default(cuid())
  agentId       String
  agent         Agent    @relation(fields: [agentId], references: [id])
  taskId        String
  task          Task     @relation(fields: [taskId], references: [id])
  outcome       Outcome
  confidence    Float    // 0.0 - 1.0
  wasOverridden Boolean  @default(false)
  wasEscalated  Boolean  @default(false)
  latencyMs     Int?
  tokens        Int?
  metadata      Json?
  createdAt     DateTime @default(now())
}

model Score {
  id            String   @id @default(cuid())
  taskId        String
  task          Task     @relation(fields: [taskId], references: [id])
  accuracyRate  Float
  confidenceAvg Float
  overrideRate  Float
  escalationRate Float
  readinessScore Float
  mode          Mode
  eventCount    Int
  calculatedAt  DateTime @default(now())
}

model Policy {
  id        String   @id @default(cuid())
  agentId   String
  name      String
  config    Json
  createdAt DateTime @default(now())
}

model Alert {
  id        String    @id @default(cuid())
  agentId   String
  agent     Agent     @relation(fields: [agentId], references: [id])
  type      AlertType
  severity  String    // "low" | "medium" | "high"
  message   String
  resolved  Boolean   @default(false)
  metadata  Json?
  createdAt DateTime  @default(now())
}
```

**Acceptance:** `pnpm db:push` applies the schema; Prisma Studio shows all seven tables.

---

## 5. Phase 3 — Scoring engine (shared logic in `packages/db` or a `packages/core`)

Single source of truth for the readiness formula. Rates are 0–1; output is 0–100.

```ts
export function readinessScore(i: {
  accuracyRate: number; confidenceAvg: number;
  overrideRate: number; escalationRate: number;
}): number {
  const raw =
    i.accuracyRate * 0.40 +
    i.confidenceAvg * 0.25 +
    (1 - i.overrideRate) * 0.20 +
    (1 - i.escalationRate) * 0.15;
  return Math.round(raw * 100);
}

export function modeForScore(s: number): "SHADOW" | "COPILOT" | "SOLO" {
  if (s <= 40) return "SHADOW";
  if (s <= 70) return "COPILOT";
  return "SOLO";
}
```

A recompute function aggregates a task's events over a **rolling 30-day window**:
- `accuracyRate` = SUCCESS / total
- `confidenceAvg` = mean(confidence)
- `overrideRate` = overridden / total
- `escalationRate` = escalated / total

…then writes a new `Score` row.

**Acceptance:** unit test confirms the three target tasks compute to 94, 66, 38 (see §6).

---

## 6. Phase 4 — Seed data (`packages/db/seed.ts`)

Seed must produce **exactly** this narrative. Generate per-event rows (not just summary scores) so trend charts and audit logs are real.

**Org:** Atlas Insurance.

**Agent 1 — "Claims Triage Agent"** with three tasks. Generate ~500 events per task spread across the last 30 days (daily jitter ±10% on rates so trend lines look earned, not flat). Tune outcome/confidence/override/escalation distributions so 30-day aggregates hit:

| Task | risk | accuracy | confidence | override | escalation | → Score | Mode |
|------|------|----------|-----------|----------|-----------|---------|------|
| Categorize claim | low | 0.95 | 0.90 | 0.05 | 0.03 | **94** | SOLO |
| Estimate payout | medium | 0.62 | 0.58 | 0.30 | 0.18 | **66** | COPILOT |
| Approve / deny claim | high | 0.35 | 0.30 | 0.60 | 0.45 | **38** | SHADOW |

> Verified against the formula: Categorize = 94, Estimate = 66, Approve/deny = 38. These sit cleanly inside SOLO / COPILOT / SHADOW with margin.

**Trend requirement:** make "Categorize claim" *climb* over the 30 days (start ~68 → end ~94) so the demo can show a Co-Pilot→Solo graduation. Keep the other two roughly flat.

**Agent 2 — "Customer Support Agent"** for the cost beat:
- Seed a normal token baseline (~1,200 tokens/event).
- Inject a **6-hour anomaly window ~7 days ago** where tokens/event spike ~9× (a tokenmaxxing loop).
- Create one `Alert` (type `RUNAWAY_COST`, severity `high`, `resolved: true`) referencing that window, plus metadata for an Efficiency Score and the Shadow-mode token cap that stopped it.

**Audit beat:** ensure at least one "Approve/deny" event is a denial with rich `metadata` (input summary, confidence, reasoning, human override) so the audit log has a defensible trail to open.

Compute and write the latest `Score` row per task at the end of seeding.

**Acceptance:** after `pnpm db:seed`, querying the three tasks returns readiness 94 / 66 / 38 with correct modes; the support agent has one resolved high-severity RUNAWAY_COST alert; one denied claim event exists with full metadata.

---

## 7. Phase 5 — API (`apps/api`, Fastify + BullMQ)

REST endpoints (single hardcoded org, no auth):

- `GET /agents` → agents with latest score per task
- `GET /agents/:id` → agent detail: tasks, each task's latest score + 30-day score history (for the trend chart)
- `GET /agents/:id/alerts` → alerts
- `GET /agents/:id/roi` → ROI Proof Engine payload: cost-per-resolved-outcome, human baseline cost, hours saved, ROI score (compute from event volume × assumptions; hardcode the human baseline assumptions in a config)
- `GET /tasks/:id/audit` → recent events with full metadata (the audit log)
- `POST /track` → **the live demo endpoint.** Accepts the SDK event schema, writes an `Event`, and enqueues a BullMQ recompute job for that task.

**BullMQ worker:** consumes recompute jobs → runs the §5 recompute → writes a fresh `Score` row. This is what makes the dashboard update live when `/track` fires.

**SDK event schema** (what `/track` accepts): `agentId`, `taskId`, `outcome`, `confidence`, `wasOverridden`, `wasEscalated`, `latencyMs?`, `tokens?`, `metadata?`.

**Acceptance:** all GETs return seeded data; POSTing to `/track` writes an event and, within a second or two, a new `Score` row appears for that task.

---

## 8. Phase 6 — SDK (`packages/sdk`)

Tiny client so the demo can show "this is how a customer integrates in one call":

```ts
import { Provable } from "@provable/sdk";
const provable = new Provable({ apiUrl: "http://localhost:4000", apiKey: "demo" });

await provable.track({
  agentId: "...",
  taskId: "...",
  outcome: "success",
  confidence: 0.91,
  wasOverridden: false,
  wasEscalated: false,
  tokens: 1180,
});
```

Internally POSTs to `/track`. Ship a `bin/` script `pnpm demo:fire` that sends one good "Categorize" event — used live in the demo to nudge the score.

**Acceptance:** `pnpm demo:fire` triggers a visible score recompute.

---

## 9. Phase 7 — Dashboard (`apps/web`, Next.js + shadcn, light theme)

Executive-readable. No jargon-only screens. Build exactly these:

1. **Header / shell** — Provable wordmark, the tagline, org switcher stub showing "Atlas Insurance."
2. **Agent Registry (`/`)** — cards for the two agents. Claims Triage card shows three task chips color-coded by mode (Solo green / Co-Pilot amber / Shadow grey).
3. **Agent Detail (`/agents/[id]`)** — the centerpiece:
   - Three **task readiness cards** side by side: big score number, mode badge, and the four sub-metrics (accuracy, confidence, override, escalation) as small bars. The visual point: *same agent, three verdicts.*
   - A **30-day trend chart** (recharts) for the selected task; default to "Categorize claim" so the Co-Pilot→Solo climb is visible.
   - A **"why this mode" panel** — for Approve/deny, surface the 60% override rate in plain English ("Your team corrected this agent on 6 of every 10 claims").
4. **Cost view** — for the Support Agent: token burn chart with the anomaly window highlighted in red, the resolved Runaway Cost alert, Efficiency Score, and the Shadow-mode token cap that stopped it.
5. **ROI panel** — cost-per-resolved-claim vs. human baseline, hours reclaimed, ROI score. Big, photographable numbers.
6. **Audit log (`/tasks/[id]/audit`)** — table of events for Approve/deny; click a denied claim to expand the full decision trail (input, confidence, reasoning, who overrode).

Design: light theme, generous whitespace, shadcn cards/badges/tables, restrained palette (one accent + the three mode colors). It must read clearly to a CFO who has never seen a terminal.

**Acceptance:** every screen renders from live API data; refreshing after `pnpm demo:fire` shows the Categorize score tick up.

---

## 10. Phase 8 — Demo readiness (the run-of-show this build must support)

Wire the app so this ~8-minute flow works without a hitch:

1. Land on registry — "you deployed agents; here's the governance layer."
2. Open Claims Triage — three task cards, three verdicts. Click Approve/deny → "why Shadow."
3. Switch trend to Categorize → show the climb into Solo.
4. **Live:** run `pnpm demo:fire`, refresh, watch the score move — "real-time, on data that never left your infra."
5. Support Agent cost view — the caught-and-capped anomaly (the Uber problem, solved).
6. ROI panel — the CFO's slide.
7. Audit log — open the denied claim — "this is your answer to the regulator."

**Final acceptance — "demo is ready when":**
- `pnpm infra:up && pnpm db:push && pnpm db:seed && pnpm dev` produces a working demo from cold.
- Scores read 94 / 66 / 38; the cost anomaly and the denied-claim audit trail are both present.
- `pnpm demo:fire` produces a visible live update.
- Every screen is legible to a non-technical executive.

---

## 11. Explicitly out of scope for the demo

Clerk/multi-tenant auth, Cloudflare R2, Helm charts, the deferred Guardrails features (Input Validation, Presidio, Tool Permission Control, Memory Safety), and the full 90-feature roadmap. Stub or omit. Keep the build tight and shippable.
