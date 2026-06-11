// Env is injected by the `dotenv -e ../../.env --` wrapper in the db:seed script.
import { prisma } from "./client.js";
import { recomputeTaskScore } from "./recompute.js";
import { readinessScore, modeForScore } from "./scoring.js";

// ---------------------------------------------------------------------------
// Deterministic RNG so every seed run produces the same narrative.
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xa71a5);
const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

type Outcome = "SUCCESS" | "FAILURE" | "PARTIAL";
interface EventRow {
  agentId: string;
  taskId: string;
  outcome: Outcome;
  confidence: number;
  wasOverridden: boolean;
  wasEscalated: boolean;
  latencyMs: number | null;
  tokens: number | null;
  metadata: any;
  createdAt: Date;
}

// Spread N timestamps across [oldestDaysAgo .. newestDaysAgo] (oldest larger).
function timestamps(n: number, oldestDaysAgo: number, newestDaysAgo: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 1 : i / (n - 1);
    let daysAgo = oldestDaysAgo + (newestDaysAgo - oldestDaysAgo) * frac;
    daysAgo += rand(-0.25, 0.25); // intraday jitter
    daysAgo = clamp(daysAgo, newestDaysAgo - 0.4, oldestDaysAgo + 0.4);
    out.push(at(daysAgo));
  }
  return out;
}

// Evenly spaced indices (with offset) for distributing exactly `k` flags over n.
function spread(n: number, k: number, offset = 0): Set<number> {
  const s = new Set<number>();
  if (k <= 0) return s;
  const stride = n / k;
  for (let j = 0; j < k; j++) {
    s.add(Math.min(n - 1, Math.floor(j * stride + offset) % n));
  }
  // In case of collisions, fill forward to guarantee exactly k.
  let i = 0;
  while (s.size < k && i < n) {
    s.add(i++);
  }
  return s;
}

// EXACT-count generator for a scoring window: counts are deterministic so the
// 30-day aggregate hits the target rate precisely, and confidence mean is
// forced to exactly `confMean`.
function genExact(opts: {
  agentId: string;
  taskId: string;
  n: number;
  successes: number;
  overridden: number;
  escalated: number;
  confMean: number;
  oldestDaysAgo: number;
  newestDaysAgo: number;
  tokensBase?: number;
}): EventRow[] {
  const { agentId, taskId, n, successes, overridden, escalated, confMean } = opts;
  const ts = timestamps(n, opts.oldestDaysAgo, opts.newestDaysAgo);

  // Non-success events are front-loaded (older) so the climb looks earned.
  const negCount = n - successes;
  const negIdx = new Set<number>();
  for (let j = 0; j < negCount; j++) {
    negIdx.add(Math.floor((j * n) / negCount));
  }
  const overIdx = spread(n, overridden, 0.5);
  const escIdx = spread(n, escalated, 1.3);

  // Raw confidence pattern, then shift so the mean is exactly confMean.
  const rawConf: number[] = [];
  for (let i = 0; i < n; i++) {
    rawConf.push(confMean + 0.04 * Math.sin((2 * Math.PI * 3 * i) / n) + rand(-0.01, 0.01));
  }
  const meanRaw = rawConf.reduce((a, b) => a + b, 0) / n;
  const shift = confMean - meanRaw;

  const rows: EventRow[] = [];
  for (let i = 0; i < n; i++) {
    const isNeg = negIdx.has(i);
    const outcome: Outcome = isNeg ? (i % 2 === 0 ? "FAILURE" : "PARTIAL") : "SUCCESS";
    rows.push({
      agentId,
      taskId,
      outcome,
      confidence: clamp(rawConf[i] + shift, 0.01, 0.99),
      wasOverridden: overIdx.has(i),
      wasEscalated: escIdx.has(i),
      latencyMs: Math.round(rand(180, 1400)),
      tokens: opts.tokensBase ? Math.round(opts.tokensBase * rand(0.85, 1.15)) : null,
      metadata: null,
      createdAt: ts[i],
    });
  }
  return rows;
}

// Sampled generator for the warm-up era (30-60 days ago). Approximate rates —
// only the latest 30-day window is gated for exactness.
function genSampled(opts: {
  agentId: string;
  taskId: string;
  n: number;
  pSuccess: number;
  confMean: number;
  pOverride: number;
  pEscalate: number;
  oldestDaysAgo: number;
  newestDaysAgo: number;
  tokensBase?: number;
}): EventRow[] {
  const ts = timestamps(opts.n, opts.oldestDaysAgo, opts.newestDaysAgo);
  const rows: EventRow[] = [];
  for (let i = 0; i < opts.n; i++) {
    const success = rng() < opts.pSuccess;
    const outcome: Outcome = success ? "SUCCESS" : rng() < 0.6 ? "FAILURE" : "PARTIAL";
    rows.push({
      agentId: opts.agentId,
      taskId: opts.taskId,
      outcome,
      confidence: clamp(opts.confMean + rand(-0.08, 0.08)),
      wasOverridden: rng() < opts.pOverride,
      wasEscalated: rng() < opts.pEscalate,
      latencyMs: Math.round(rand(180, 1400)),
      tokens: opts.tokensBase ? Math.round(opts.tokensBase * rand(0.85, 1.15)) : null,
      metadata: null,
      createdAt: ts[i],
    });
  }
  return rows;
}

async function insertAll(rows: EventRow[]) {
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.event.createMany({ data: rows.slice(i, i + CHUNK) });
  }
}

async function main() {
  console.log("Resetting database…");
  await prisma.score.deleteMany();
  await prisma.event.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.task.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.org.deleteMany();

  const org = await prisma.org.create({ data: { name: "Atlas Insurance" } });

  // -------------------------------------------------------------------------
  // Agent 1 — Claims Triage Agent (the readiness story)
  // -------------------------------------------------------------------------
  const triage = await prisma.agent.create({
    data: { orgId: org.id, name: "Claims Triage Agent", purpose: "Triages inbound P&C claims: categorize, estimate, and recommend approve/deny." },
  });

  const categorize = await prisma.task.create({ data: { agentId: triage.id, name: "Categorize claim", riskLevel: "low" } });
  const estimate = await prisma.task.create({ data: { agentId: triage.id, name: "Estimate payout", riskLevel: "medium" } });
  const approve = await prisma.task.create({ data: { agentId: triage.id, name: "Approve / deny claim", riskLevel: "high" } });
  // Recently-deployed task with a deliberately small evidence window — sits just
  // under the SOLO threshold so the live demo (demo:fire) can flip it COPILOT->SOLO.
  const duplicate = await prisma.task.create({ data: { agentId: triage.id, name: "Flag potential duplicate claim", riskLevel: "medium" } });

  const allEvents: EventRow[] = [];

  // Categorize → SCORE 94 (SOLO). Scoring window (last 30d) is exact;
  // warm-up era (30-60d ago) is the lower "Co-Pilot" past so the rolling
  // 30-day score climbs ~68 → 94 as the window slides off the old era.
  // Exact: n=500, success=475 (.95), override=25 (.05), escalate=15 (.03), conf=.90
  allEvents.push(
    ...genExact({ agentId: triage.id, taskId: categorize.id, n: 500, successes: 475, overridden: 25, escalated: 15, confMean: 0.9, oldestDaysAgo: 29.5, newestDaysAgo: 0.2, tokensBase: 900 }),
  );
  allEvents.push(
    ...genSampled({ agentId: triage.id, taskId: categorize.id, n: 420, pSuccess: 0.66, confMean: 0.6, pOverride: 0.28, pEscalate: 0.16, oldestDaysAgo: 59, newestDaysAgo: 30.3, tokensBase: 900 }),
  );

  // Estimate payout → SCORE 66 (COPILOT), roughly flat.
  // Exact: n=500, success=310 (.62), override=150 (.30), escalate=90 (.18), conf=.58
  allEvents.push(
    ...genExact({ agentId: triage.id, taskId: estimate.id, n: 500, successes: 310, overridden: 150, escalated: 90, confMean: 0.58, oldestDaysAgo: 29.5, newestDaysAgo: 0.2, tokensBase: 1500 }),
  );
  allEvents.push(
    ...genSampled({ agentId: triage.id, taskId: estimate.id, n: 420, pSuccess: 0.62, confMean: 0.58, pOverride: 0.3, pEscalate: 0.18, oldestDaysAgo: 59, newestDaysAgo: 30.3, tokensBase: 1500 }),
  );

  // Approve / deny → SCORE 38 (SHADOW), roughly flat.
  // Exact: n=500, success=175 (.35), override=300 (.60), escalate=225 (.45), conf=.30
  const approveRows = genExact({ agentId: triage.id, taskId: approve.id, n: 500, successes: 175, overridden: 300, escalated: 225, confMean: 0.3, oldestDaysAgo: 29.5, newestDaysAgo: 0.2, tokensBase: 2100 });

  // Audit beat: attach rich, defensible metadata to a handful of denials.
  const denialScenarios = [
    { inputSummary: "Auto claim #AC-48217: rear-end collision, $14,200 estimate, policy active 11 mo, prior claims: 2", confidence: 0.31, reasoning: "Flagged staged-collision pattern (low-speed impact + soft-tissue injury + new policy). Confidence below approve threshold.", humanOverride: { overrodeTo: "APPROVE", by: "S. Whitfield (Sr. Adjuster)", note: "Police report confirms third-party fault; pattern match was a false positive." } },
    { inputSummary: "Property claim #PR-90431: water damage, $8,750, policy active 4 mo", confidence: 0.27, reasoning: "Damage timeline inconsistent with reported storm date; recommended denial pending inspection.", humanOverride: { overrodeTo: "APPROVE", by: "M. Okafor (Adjuster)", note: "Independent inspection validated claim; agent lacked weather-service data." } },
    { inputSummary: "Auto claim #AC-51120: total loss, $22,900, policy active 2 mo", confidence: 0.22, reasoning: "Vehicle value exceeds declared income bracket; high fraud likelihood.", humanOverride: { overrodeTo: "DENY", by: "S. Whitfield (Sr. Adjuster)", note: "Upheld — VIN history shows prior salvage title not disclosed." } },
    { inputSummary: "Liability claim #LB-33902: slip-and-fall, $5,400", confidence: 0.34, reasoning: "No corroborating incident report from premises; recommend deny.", humanOverride: { overrodeTo: "APPROVE", by: "R. Delgado (Adjuster)", note: "CCTV later produced; claim legitimate." } },
    { inputSummary: "Auto claim #AC-55310: windshield, $1,150", confidence: 0.29, reasoning: "Duplicate-of-record suspected against claim AC-55109.", humanOverride: { overrodeTo: "DENY", by: "M. Okafor (Adjuster)", note: "Upheld — confirmed duplicate submission." } },
  ];
  let attached = 0;
  for (let i = 0; i < approveRows.length && attached < denialScenarios.length; i++) {
    const r = approveRows[i];
    if (r.outcome !== "SUCCESS" && r.wasOverridden) {
      const s = denialScenarios[attached];
      r.metadata = { decision: "DENY", inputSummary: s.inputSummary, confidence: s.confidence, reasoning: s.reasoning, humanOverride: s.humanOverride, claimType: "auto/property/liability" };
      r.confidence = s.confidence;
      // Surface these denials at the TOP of the audit log: date them in the last ~2 days.
      r.createdAt = at(0.1 + attached * 0.35);
      attached++;
    }
  }
  // One clean upheld denial (no override) for contrast in the audit log — also recent.
  const upheld = approveRows.find((r) => r.outcome === "SUCCESS" && !r.wasOverridden);
  if (upheld) {
    upheld.metadata = { decision: "DENY", inputSummary: "Auto claim #AC-60022: bumper scuff, $640, two claims in 30 days", confidence: 0.81, reasoning: "Below deductible after policy terms; correct automated denial.", humanOverride: null, claimType: "auto" };
    upheld.createdAt = at(0.05);
  }
  allEvents.push(...approveRows);
  allEvents.push(
    ...genSampled({ agentId: triage.id, taskId: approve.id, n: 420, pSuccess: 0.35, confMean: 0.3, pOverride: 0.6, pEscalate: 0.45, oldestDaysAgo: 59, newestDaysAgo: 30.3, tokensBase: 2100 }),
  );

  // Flag potential duplicate claim -> SCORE 67 (COPILOT), tiny 18-event window
  // dated to the last ~5 days (a freshly deployed task). A demo:fire burst of 5
  // strong-success events crosses 71 -> SOLO. See DUP_FIRE constants below.
  // Exact: n=18, success=12 (.667), override=4 (.222), escalate=2 (.111), conf=.46 -> 67
  const duplicateRows = genExact({ agentId: triage.id, taskId: duplicate.id, n: 18, successes: 12, overridden: 4, escalated: 2, confMean: 0.46, oldestDaysAgo: 5, newestDaysAgo: 0.2, tokensBase: 1000 });
  allEvents.push(...duplicateRows);

  // -------------------------------------------------------------------------
  // Agent 2 — Customer Support Agent (the cost-governance story)
  // -------------------------------------------------------------------------
  const support = await prisma.agent.create({
    data: { orgId: org.id, name: "Customer Support Agent", purpose: "Handles tier-1 policyholder support: status lookups, FAQ, and ticket resolution." },
  });
  const resolveTicket = await prisma.task.create({ data: { agentId: support.id, name: "Resolve support ticket", riskLevel: "low" } });

  // Normal token baseline ~1,200 tokens/event across 30 days.
  const supportRows = genSampled({ agentId: support.id, taskId: resolveTicket.id, n: 600, pSuccess: 0.9, confMean: 0.86, pOverride: 0.06, pEscalate: 0.08, oldestDaysAgo: 30, newestDaysAgo: 0.2, tokensBase: 1200 });

  // Inject a 6-hour tokenmaxxing anomaly ~7 days ago: ~9x token spike.
  const anomalyStart = 7 + 6 / 24; // 7d6h ago
  const anomalyEnd = 7; // 7d ago
  const NORMAL_TOKENS = 1200;
  const SPIKE_TOKENS = NORMAL_TOKENS * 9;
  const anomalyEvents: EventRow[] = [];
  const anomalyTs = timestamps(80, anomalyStart, anomalyEnd);
  for (let i = 0; i < anomalyTs.length; i++) {
    anomalyEvents.push({
      agentId: support.id,
      taskId: resolveTicket.id,
      outcome: rng() < 0.7 ? "SUCCESS" : "PARTIAL",
      confidence: clamp(0.7 + rand(-0.1, 0.1)),
      wasOverridden: false,
      wasEscalated: rng() < 0.2,
      latencyMs: Math.round(rand(3000, 9000)),
      tokens: Math.round(SPIKE_TOKENS * rand(0.85, 1.15)),
      metadata: { anomaly: true, loop: "self-referential tool call" },
      createdAt: anomalyTs[i],
    });
  }
  allEvents.push(...supportRows, ...anomalyEvents);

  console.log(`Inserting ${allEvents.length} events…`);
  await insertAll(allEvents);

  // Resolved RUNAWAY_COST alert referencing the anomaly window.
  await prisma.alert.create({
    data: {
      agentId: support.id,
      type: "RUNAWAY_COST",
      severity: "high",
      message: "Runaway token consumption detected on Customer Support Agent — 9× baseline for 6 hours. Auto-capped under Shadow-mode token policy.",
      resolved: true,
      metadata: {
        windowStart: at(anomalyStart).toISOString(),
        windowEnd: at(anomalyEnd).toISOString(),
        normalTokensPerEvent: NORMAL_TOKENS,
        peakTokensPerEvent: SPIKE_TOKENS,
        spikeMultiplier: 9,
        efficiencyScore: 41,
        tokenCapPerEvent: 2000,
        action: "Shadow-mode token cap engaged; agent throttled and flagged for review.",
        estimatedOverspendUsd: 2840,
        savedByCapUsd: 2310,
        resolvedBy: "Provable Cost Governor (auto)",
      },
    },
  });

  // A baseline cost policy for the support agent.
  await prisma.policy.create({
    data: { agentId: support.id, name: "Shadow-mode token cap", config: { maxTokensPerEvent: 2000, mode: "SHADOW", action: "throttle_and_flag" } },
  });

  // -------------------------------------------------------------------------
  // Trend history: write rolling 30-day Score rows so charts are real.
  // For each Claims task, recompute at each day across the last 30 days.
  // -------------------------------------------------------------------------
  console.log("Computing 30-day score history…");
  for (const task of [categorize, estimate, approve, duplicate]) {
    for (let d = 30; d >= 0; d--) {
      await recomputeTaskScore(task.id, at(d));
    }
  }
  // Support task — a current score so it appears in the registry.
  await recomputeTaskScore(resolveTicket.id, NOW);

  // -------------------------------------------------------------------------
  // Verify the gate.
  // -------------------------------------------------------------------------
  console.log("\n=== HARD GATE: latest readiness per task ===");
  const targets: Record<string, { score: number; mode: string }> = {
    "Categorize claim": { score: 94, mode: "SOLO" },
    "Estimate payout": { score: 66, mode: "COPILOT" },
    "Approve / deny claim": { score: 38, mode: "SHADOW" },
  };
  let gatePass = true;
  for (const task of [categorize, estimate, approve]) {
    const latest = await prisma.score.findFirst({ where: { taskId: task.id }, orderBy: { calculatedAt: "desc" } });
    const want = targets[task.name];
    const ok = latest != null && Math.round(latest.readinessScore) === want.score && latest.mode === want.mode;
    if (!ok) gatePass = false;
    console.log(`${ok ? "PASS" : "FAIL"}  ${task.name.padEnd(30)} score=${latest?.readinessScore} mode=${latest?.mode}  (want ${want.score}/${want.mode})`);
  }

  // Fourth task — the live-beat task. Verify pre-fire 67/COPILOT and predict the
  // deterministic post-fire crossing when demo:fire sends DUP_FIRE_COUNT strong events.
  const DUP_FIRE_COUNT = 5;
  const DUP_FIRE_CONF = 0.95;
  const dupLatest = await prisma.score.findFirst({ where: { taskId: duplicate.id }, orderBy: { calculatedAt: "desc" } });
  const dupPreOk = dupLatest != null && Math.round(dupLatest.readinessScore) === 67 && dupLatest.mode === "COPILOT";
  if (!dupPreOk) gatePass = false;
  console.log(`${dupPreOk ? "PASS" : "FAIL"}  ${"Flag potential duplicate claim".padEnd(30)} score=${dupLatest?.readinessScore} mode=${dupLatest?.mode}  (want 67/COPILOT)  eventCount=${dupLatest?.eventCount}`);

  // Predicted post-fire (deterministic): add 5 success events at conf 0.95.
  const n0 = 18, s0 = 12, o0 = 4, e0 = 2, cs0 = 0.46 * 18;
  const n1 = n0 + DUP_FIRE_COUNT, s1 = s0 + DUP_FIRE_COUNT, cs1 = cs0 + DUP_FIRE_COUNT * DUP_FIRE_CONF;
  const postScore = readinessScore({ accuracyRate: s1 / n1, confidenceAvg: cs1 / n1, overrideRate: o0 / n1, escalationRate: e0 / n1 });
  const postMode = modeForScore(postScore);
  const crossOk = postScore >= 71 && postMode === "SOLO";
  if (!crossOk) gatePass = false;
  console.log(`${crossOk ? "PASS" : "FAIL"}  Live-beat crossing: ${dupLatest?.readinessScore}/COPILOT --(${DUP_FIRE_COUNT}x success@${DUP_FIRE_CONF})--> ${postScore}/${postMode}  (must cross 71 -> SOLO)`);

  const costAlert = await prisma.alert.findFirst({ where: { agentId: support.id, type: "RUNAWAY_COST", severity: "high", resolved: true } });
  console.log(`${costAlert ? "PASS" : "FAIL"}  Customer Support Agent has one resolved high-severity RUNAWAY_COST alert`);

  const denial = await prisma.event.findFirst({
    where: { taskId: approve.id, wasOverridden: true, NOT: { metadata: { equals: null } } },
    orderBy: { createdAt: "desc" },
  });
  const denialOk = !!denial && (denial.metadata as any)?.decision === "DENY" && !!(denial.metadata as any)?.humanOverride;
  console.log(`${denialOk ? "PASS" : "FAIL"}  At least one Approve/deny event is a denial with full metadata + human override`);

  if (!gatePass || !costAlert || !denialOk) {
    console.error("\nSEED GATE FAILED — numbers are off. Not safe to proceed.");
    process.exit(1);
  }
  console.log("\nSeed complete. Scores read 94 / 66 / 38 (SOLO / COPILOT / SHADOW).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
