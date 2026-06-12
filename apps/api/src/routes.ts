import type { FastifyInstance } from "fastify";
import { prisma } from "@provable/db";
import { computeRoi } from "./roi.js";
import { enqueueRecompute } from "./queue.js";

async function latestScore(taskId: string) {
  return prisma.score.findFirst({ where: { taskId }, orderBy: { calculatedAt: "desc" } });
}

export async function registerRoutes(app: FastifyInstance) {
  // GET /agents — agents with latest score per task.
  app.get("/agents", async () => {
    const agents = await prisma.agent.findMany({
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
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
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
  app.get<{ Params: { id: string } }>("/agents/:id/alerts", async (req) => {
    return prisma.alert.findMany({ where: { agentId: req.params.id }, orderBy: { createdAt: "desc" } });
  });

  // GET /agents/:id/roi — ROI Proof Engine payload.
  app.get<{ Params: { id: string } }>("/agents/:id/roi", async (req) => {
    return computeRoi(req.params.id);
  });

  // GET /tasks/:id/audit — recent events with full metadata.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/tasks/:id/audit", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    const events = await prisma.event.findMany({
      where: { taskId: req.params.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return { task, events };
  });

  // GET /agents/:id/tokens — token-burn series for the cost view (support agent).
  app.get<{ Params: { id: string } }>("/agents/:id/tokens", async (req) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const events = await prisma.event.findMany({
      where: { agentId: req.params.id, createdAt: { gte: since }, tokens: { not: null } },
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
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

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
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

    const grouped = await prisma.gatewayCall.groupBy({
      by: ["agentId"],
      where: { orgId: org.id },
      _sum: { costUsd: true },
      _count: { _all: true },
    });

    const agentIds = grouped.map((g) => g.agentId).filter((id): id is string => !!id);
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } });
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
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

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
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

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

  // GET /org/key — returns the authenticated org's API key + the public API
  // URL agents should call. Powers the dashboard's self-service onboarding modal.
  app.get("/org/key", async (req, reply) => {
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

    const apiUrl =
      process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.headers.host}`;

    return { apiKey: org.apiKey, apiUrl };
  });

  // POST /register — self-enrollment by org key. Idempotent: upsert agent by
  // (orgId, name) and each task by (agentId, key). No internal IDs cross the wire.
  app.post<{ Body: RegisterBody }>("/register", async (req, reply) => {
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

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
      const org = await orgFromKey(req);
      if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

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

async function orgFromKey(req: { headers: Record<string, any> }) {
  const key = req.headers["x-provable-key"];
  if (!key) return null;
  return prisma.org.findUnique({ where: { apiKey: String(key) } });
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
