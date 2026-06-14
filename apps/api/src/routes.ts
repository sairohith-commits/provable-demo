import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { prismaScoped as prisma, hashApiKey, type Org } from "@provable/db";
import { computeRoi } from "./roi.js";
import { enqueueRecompute } from "./queue.js";

// Every request that presents a valid x-provable-key gets req.org set here.
declare module "fastify" {
  interface FastifyRequest {
    org?: Org;
  }
}

// Constant-time comparison of the presented internal token against the expected
// secret. Length-mismatch short-circuits (timingSafeEqual requires equal length);
// the secret itself is never logged or echoed.
function safeTokenEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Resolve the authenticated org and set req.org. Two auth paths:
//
//   1. Internal service-token branch (P2 / D3) — checked FIRST, allowed ONLY on
//      dashboard READ routes (opts.allowInternal). The trusted web tier presents
//      `Authorization: Bearer <PROVABLE_INTERNAL_TOKEN>` + `x-provable-org-id`.
//      The org id is server-derived from a Clerk-verified session upstream, never
//      client input. A valid token resolves the org by id; once req.org is set the
//      request flows through the SAME P1 tenant-guard as the machine-key path.
//   2. Machine-key branch (P1) — sha256 of `x-provable-key` against the unique
//      apiKeyHash index. This is the ONLY path on ingestion (/track*) and gateway
//      routes; the internal branch is never offered there.
//
// On failure it sends the 401 and returns null, so callers do
// `const org = await requireOrg(req, reply, opts); if (!org) return;`.
async function requireOrg(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { allowInternal?: boolean } = {},
): Promise<Org | null> {
  // --- Internal service-token branch (dashboard read routes only) ---
  if (opts.allowInternal) {
    const authz = req.headers["authorization"];
    const bearer =
      typeof authz === "string" && authz.startsWith("Bearer ") ? authz.slice("Bearer ".length) : null;
    if (bearer !== null) {
      // A Bearer was presented → this is an internal-auth attempt. Validate it
      // fully here; do NOT fall back to the machine-key path on a bad token.
      const expected = process.env.PROVABLE_INTERNAL_TOKEN;
      if (!expected || !safeTokenEqual(bearer, expected)) {
        reply.code(401).send({ error: "invalid_internal_token" });
        return null;
      }
      const orgId = req.headers["x-provable-org-id"];
      if (typeof orgId !== "string" || orgId.length === 0) {
        reply.code(401).send({ error: "missing_org_id" });
        return null;
      }
      const org = await prisma.org.findUnique({ where: { id: orgId } });
      if (!org) {
        reply.code(401).send({ error: "invalid_org_id" });
        return null;
      }
      req.org = org;
      return org;
    }
    // No Bearer → fall through to the machine-key path below.
  }

  // --- Machine-key branch (P1, unchanged) ---
  const presented = req.headers["x-provable-key"];
  if (typeof presented !== "string" || !presented.startsWith("pk_live_")) {
    reply.code(401).send({ error: "missing_or_malformed_key" });
    return null;
  }
  const org = await prisma.org.findUnique({ where: { apiKeyHash: hashApiKey(presented) } });
  if (!org) {
    reply.code(401).send({ error: "invalid_key" });
    return null;
  }
  req.org = org;
  return org;
}

async function latestScore(taskId: string) {
  return prisma.score.findFirst({ where: { taskId }, orderBy: { calculatedAt: "desc" } });
}

export async function registerRoutes(app: FastifyInstance) {
  // GET /agents — agents with latest score per task (scoped to the caller's org).
  app.get("/agents", async (req, reply) => {
    const org = await requireOrg(req, reply, { allowInternal: true });
    if (!org) return;

    const agents = await prisma.agent.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: "asc" },
      include: { tasks: { orderBy: { createdAt: "asc" } } },
    });

    return Promise.all(
      agents.map(async (a) => {
        const lastEvent = await prisma.event.findFirst({
          where: { agentId: a.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        return {
          id: a.id,
          name: a.name,
          purpose: a.purpose,
          createdAt: a.createdAt,
          lastEventAt: lastEvent?.createdAt ?? null,
          tasks: await Promise.all(
            a.tasks.map(async (t) => ({
              id: t.id,
              name: t.name,
              key: t.key,
              riskLevel: t.riskLevel,
              latestScore: await latestScore(t.id),
            })),
          ),
        };
      }),
    );
  });

  // GET /agents/:id — detail with each task's latest score + 30-day history.
  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const org = await requireOrg(req, reply, { allowInternal: true });
    if (!org) return;

    const agent = await prisma.agent.findFirst({
      where: { id: req.params.id, orgId: org.id },
      include: { tasks: { orderBy: { createdAt: "asc" } } },
    });
    if (!agent) return reply.code(404).send({ error: "agent not found" });

    const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const tasks = await Promise.all(
      agent.tasks.map(async (t) => {
        const history = await prisma.score.findMany({
          where: { taskId: t.id, calculatedAt: { gte: since } },
          orderBy: { calculatedAt: "asc" },
          select: { readinessScore: true, mode: true, accuracyRate: true, confidenceAvg: true, overrideRate: true, escalationRate: true, eventCount: true, calculatedAt: true },
        });
        return {
          id: t.id,
          name: t.name,
          riskLevel: t.riskLevel,
          latestScore: history[history.length - 1] ?? null,
          history,
        };
      }),
    );

    return { id: agent.id, name: agent.name, purpose: agent.purpose, tasks };
  });

  // GET /agents/:id/alerts
  app.get<{ Params: { id: string } }>("/agents/:id/alerts", async (req, reply) => {
    const org = await requireOrg(req, reply, { allowInternal: true });
    if (!org) return;
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, orgId: org.id }, select: { id: true } });
    if (!agent) return reply.code(404).send({ error: "agent not found" });

    return prisma.alert.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: "desc" } });
  });

  // GET /agents/:id/roi — ROI Proof Engine payload.
  app.get<{ Params: { id: string } }>("/agents/:id/roi", async (req, reply) => {
    const org = await requireOrg(req, reply, { allowInternal: true });
    if (!org) return;
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, orgId: org.id }, select: { id: true } });
    if (!agent) return reply.code(404).send({ error: "agent not found" });

    return computeRoi(agent.id);
  });

  // GET /tasks/:id/audit — recent events with full metadata (scoped via the
  // task's agent -> org chain).
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/tasks/:id/audit", async (req, reply) => {
    const org = await requireOrg(req, reply, { allowInternal: true });
    if (!org) return;
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const task = await prisma.task.findFirst({ where: { id: req.params.id, agent: { orgId: org.id } } });
    if (!task) return reply.code(404).send({ error: "task not found" });

    const events = await prisma.event.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return { task, events };
  });

  // GET /agents/:id/tokens — token-burn series for the cost view (support agent).
  app.get<{ Params: { id: string } }>("/agents/:id/tokens", async (req, reply) => {
    const org = await requireOrg(req, reply, { allowInternal: true });
    if (!org) return;
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, orgId: org.id }, select: { id: true } });
    if (!agent) return reply.code(404).send({ error: "agent not found" });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const events = await prisma.event.findMany({
      where: { agentId: agent.id, createdAt: { gte: since }, tokens: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { tokens: true, createdAt: true, metadata: true },
    });
    // Bucket by hour for a clean chart.
    const buckets = new Map<string, { ts: string; tokens: number; count: number; anomaly: boolean }>();
    for (const e of events) {
      const d = new Date(e.createdAt);
      d.setMinutes(0, 0, 0);
      const key = d.toISOString();
      const b = buckets.get(key) ?? { ts: key, tokens: 0, count: 0, anomaly: false };
      b.tokens += e.tokens ?? 0;
      b.count += 1;
      if ((e.metadata as any)?.anomaly) b.anomaly = true;
      buckets.set(key, b);
    }
    return Array.from(buckets.values()).map((b) => ({
      ts: b.ts,
      avgTokens: Math.round(b.tokens / Math.max(1, b.count)),
      totalTokens: b.tokens,
      anomaly: b.anomaly,
    }));
  });

  // ---- Gateway telemetry (apps/gateway captures GatewayCall rows) ----

  // GET /gateway/stats — last-24h call volume / spend + discovery summary.
  app.get("/gateway/stats", async (req, reply) => {
    const org = await requireOrg(req, reply);
    if (!org) return;

    // Rolling 24h window (not UTC-calendar-day) — avoids the midnight
    // boundary artifact and is correct regardless of the org's timezone.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [today, agentsDiscovered, last] = await Promise.all([
      prisma.gatewayCall.aggregate({
        where: { orgId: org.id, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costUsd: true },
      }),
      prisma.gatewayCall.findMany({
        where: { orgId: org.id, agentId: { not: null } },
        distinct: ["agentId"],
        select: { agentId: true },
      }),
      prisma.gatewayCall.findFirst({
        where: { orgId: org.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    return {
      callsToday: today._count._all,
      spendToday: today._sum.costUsd ?? 0,
      agentsDiscovered: agentsDiscovered.length,
      lastCallAt: last?.createdAt ?? null,
    };
  });

  // GET /gateway/by-agent — spend + call count grouped by agent.
  app.get("/gateway/by-agent", async (req, reply) => {
    const org = await requireOrg(req, reply);
    if (!org) return;

    const grouped = await prisma.gatewayCall.groupBy({
      by: ["agentId"],
      where: { orgId: org.id },
      _sum: { costUsd: true },
      _count: { _all: true },
    });

    const agentIds = grouped.map((g) => g.agentId).filter((id): id is string => !!id);
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds }, orgId: org.id }, select: { id: true, name: true } });
    const nameById = new Map(agents.map((a) => [a.id, a.name]));

    return grouped
      .map((g) => ({
        agent: g.agentId ? (nameById.get(g.agentId) ?? "unknown") : "unknown",
        costUsd: g._sum.costUsd ?? 0,
        calls: g._count._all,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
  });

  // GET /gateway/by-model — call share grouped by model.
  app.get("/gateway/by-model", async (req, reply) => {
    const org = await requireOrg(req, reply);
    if (!org) return;

    const grouped = await prisma.gatewayCall.groupBy({
      by: ["model"],
      where: { orgId: org.id },
      _count: { _all: true },
    });

    const total = grouped.reduce((sum, g) => sum + g._count._all, 0);

    return grouped
      .map((g) => ({
        model: g.model,
        calls: g._count._all,
        pct: total > 0 ? (g._count._all / total) * 100 : 0,
      }))
      .sort((a, b) => b.calls - a.calls);
  });

  // GET /gateway/feed?limit=50 — recent calls, most recent first.
  app.get<{ Querystring: { limit?: string } }>("/gateway/feed", async (req, reply) => {
    const org = await requireOrg(req, reply);
    if (!org) return;

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const calls = await prisma.gatewayCall.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { agent: { select: { name: true } } },
    });

    return calls.map((c) => ({
      agent: c.agent?.name ?? "unknown",
      model: c.model,
      tokens: c.inputTokens + c.outputTokens,
      costUsd: c.costUsd,
      ago: relativeTime(c.createdAt),
    }));
  });

  // GET /org/key — READ path. The full key is unrecoverable (only its hash +
  // display prefix are stored), so this returns the prefix ONLY, never a usable
  // key. The full key is shown once at creation/rotation. Powers the dashboard's
  // onboarding modal (identification + the public API URL agents should call).
  app.get("/org/key", async (req, reply) => {
    const org = await requireOrg(req, reply);
    if (!org) return;

    const apiUrl =
      process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.headers.host}`;

    return { apiKeyPrefix: org.apiKeyPrefix, apiUrl };
  });

  // POST /register — self-enrollment by org key. Idempotent: upsert agent by
  // (orgId, name) and each task by (agentId, key). No internal IDs cross the wire.
  app.post<{ Body: RegisterBody }>("/register", async (req, reply) => {
    const org = await requireOrg(req, reply);
    if (!org) return;

    const b = req.body;
    if (!b?.agent || !Array.isArray(b.tasks) || b.tasks.length === 0) {
      return reply.code(400).send({ error: "body requires { agent: string, tasks: [{ key, name, riskLevel }] }" });
    }

    let agent = await prisma.agent.findFirst({ where: { orgId: org.id, name: b.agent } });
    if (!agent) {
      agent = await prisma.agent.create({ data: { orgId: org.id, name: b.agent, purpose: b.purpose ?? "" } });
    } else if (b.purpose && b.purpose !== agent.purpose) {
      agent = await prisma.agent.update({ where: { id: agent.id }, data: { purpose: b.purpose } });
    }

    for (const t of b.tasks) {
      if (!t?.key || !t?.name) continue;
      await prisma.task.upsert({
        where: { agentId_key: { agentId: agent.id, key: t.key } },
        update: { name: t.name, riskLevel: t.riskLevel ?? "medium" },
        create: { agentId: agent.id, key: t.key, name: t.name, riskLevel: t.riskLevel ?? "medium" },
      });
    }
    return reply.send({ ok: true, agent: agent.name, tasks: b.tasks.length });
  });

  // POST /track — dual mode.
  //  - Authenticated name/key path (customer-facing): header x-provable-key +
  //    x-provable-agent + body { task: <key>, ... }. Resolves org->agent->task
  //    (task upserted if unseen). 401 on missing/invalid key.
  //  - Legacy id path (Phase 8 demo:fire / Phase 9 internal agents): body
  //    { agentId, taskId, ... }. Unchanged, so existing demos keep working.
  app.post<{ Body: TrackBody }>("/track", async (req, reply) => {
    const b = req.body;

    // The customer-facing path is signalled by a task KEY in the body. The
    // legacy by-id path (demo:fire / internal agents) never sends `task`, so it
    // is unaffected by any headers.
    if (b?.task) {
      const org = await requireOrg(req, reply);
      if (!org) return;

      const agentName = req.headers["x-provable-agent"];
      if (!agentName || !b?.task || !b?.outcome) {
        return reply.code(400).send({ error: "requires x-provable-agent header and body { task, outcome }" });
      }
      const outcome = normalizeOutcome(b.outcome);
      if (!outcome) return reply.code(400).send({ error: "outcome must be success | failure | partial" });

      const agent = await prisma.agent.findFirst({ where: { orgId: org.id, name: String(agentName) } });
      if (!agent) return reply.code(404).send({ error: `agent "${agentName}" is not registered for this org` });

      // Resolve task by key; upsert if this is a task we haven't seen yet.
      let task = await prisma.task.findFirst({ where: { agentId: agent.id, key: String(b.task) } });
      if (!task) {
        task = await prisma.task.create({ data: { agentId: agent.id, key: String(b.task), name: String(b.task), riskLevel: "medium" } });
      }

      const event = await prisma.event.create({
        data: {
          agentId: agent.id,
          taskId: task.id,
          outcome: outcome as any,
          confidence: typeof b.confidence === "number" ? b.confidence : 0.5,
          wasOverridden: !!b.wasOverridden,
          wasEscalated: !!b.wasEscalated,
          latencyMs: b.latencyMs ?? null,
          tokens: b.tokens ?? null,
          metadata: b.metadata ?? undefined,
        },
      });
      await enqueueRecompute(task.id);

      // Cost governor: a single event burning past the runaway threshold trips a
      // RUNAWAY_COST alert (once per hour per agent) and tells the agent to cap.
      const cap = await maybeRaiseRunawayAlert(agent.id, agent.name, b.tokens ?? null);
      return reply.code(201).send({ ok: true, eventId: event.id, queued: true, capped: cap != null, capTokens: cap ?? undefined });
    }

    // Legacy by-id path.
    if (!b?.agentId || !b?.taskId || !b?.outcome) {
      return reply.code(400).send({ error: "agentId, taskId, and outcome are required" });
    }
    const outcome = normalizeOutcome(b.outcome);
    if (!outcome) return reply.code(400).send({ error: "outcome must be success | failure | partial" });

    const event = await prisma.event.create({
      data: {
        agentId: b.agentId,
        taskId: b.taskId,
        outcome: outcome as any,
        confidence: typeof b.confidence === "number" ? b.confidence : 0.5,
        wasOverridden: !!b.wasOverridden,
        wasEscalated: !!b.wasEscalated,
        latencyMs: b.latencyMs ?? null,
        tokens: b.tokens ?? null,
        metadata: b.metadata ?? undefined,
      },
    });
    await enqueueRecompute(b.taskId);
    return reply.code(201).send({ ok: true, eventId: event.id, queued: true });
  });
}

// Cost governor for self-enrolled agents. A real token spike on a tracked event
// raises a high-severity RUNAWAY_COST alert (deduped to once/hour/agent) and
// returns the token cap the agent should enforce. Additive — scoring untouched.
const RUNAWAY_TOKEN_THRESHOLD = 3000;
const RUNAWAY_TOKEN_CAP = 2000;

async function maybeRaiseRunawayAlert(agentId: string, agentName: string, tokens: number | null): Promise<number | null> {
  if (tokens == null || tokens <= RUNAWAY_TOKEN_THRESHOLD) return null;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const existing = await prisma.alert.findFirst({
    where: { agentId, type: "RUNAWAY_COST", createdAt: { gte: oneHourAgo } },
  });
  if (!existing) {
    await prisma.alert.create({
      data: {
        agentId,
        type: "RUNAWAY_COST",
        severity: "high",
        message: `Runaway token consumption detected on ${agentName} — ${tokens} tokens on a single decision (threshold ${RUNAWAY_TOKEN_THRESHOLD}). Token cap (${RUNAWAY_TOKEN_CAP}/event) engaged.`,
        resolved: true,
        metadata: {
          peakTokensPerEvent: tokens,
          thresholdTokensPerEvent: RUNAWAY_TOKEN_THRESHOLD,
          tokenCapPerEvent: RUNAWAY_TOKEN_CAP,
          action: `Cost governor engaged a ${RUNAWAY_TOKEN_CAP}-token cap; agent throttled and flagged for review.`,
          detectedBy: "Provable Cost Governor (real-time, on /track)",
        },
      },
    });
  }
  return RUNAWAY_TOKEN_CAP;
}

// "3m ago", "2h ago", "just now" — for the gateway feed.
function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const s = Math.max(0, Math.round(diffMs / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function normalizeOutcome(o: unknown): string | null {
  const up = String(o).toUpperCase();
  return ["SUCCESS", "FAILURE", "PARTIAL"].includes(up) ? up : null;
}

interface RegisterBody {
  agent: string;
  purpose?: string;
  tasks: Array<{ key: string; name: string; riskLevel?: string }>;
}

interface TrackBody {
  // legacy id path
  agentId?: string;
  taskId?: string;
  // name/key path
  task?: string;
  outcome: string;
  confidence?: number;
  wasOverridden?: boolean;
  wasEscalated?: boolean;
  latencyMs?: number;
  tokens?: number;
  metadata?: unknown;
}
