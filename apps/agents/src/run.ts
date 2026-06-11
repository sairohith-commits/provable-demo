import { prisma } from "@provable/db";
import { loadClaims, TASK_NAME, ESCALATION_THRESHOLD, type Claim, type TaskKey } from "./dataset.js";
import { runWorker } from "./worker.js";
import { runReviewer } from "./reviewer.js";
import { provable, resolveTargets, taskScores, type Targets } from "./api.js";
import { callModel } from "./anthropic.js";
import { AGENT_MODEL } from "./env.js";
import { costUsd, usd } from "./cost.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CostAcc {
  agentIn: number;
  agentOut: number;
  reviewerIn: number;
  reviewerOut: number;
  workerCount: number;
}
const newCost = (): CostAcc => ({ agentIn: 0, agentOut: 0, reviewerIn: 0, reviewerOut: 0, workerCount: 0 });

function parseFlags(argv: string[]) {
  const out: { limit?: number; task?: TaskKey; count?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") out.limit = Number(argv[++i]);
    else if (argv[i] === "--task") out.task = argv[++i] as TaskKey;
    else if (argv[i] === "--count") out.count = Number(argv[++i]);
  }
  return out;
}

function buildMetadata(claim: Claim, worker: Awaited<ReturnType<typeof runWorker>>, review: Awaited<ReturnType<typeof runReviewer>>) {
  const base: Record<string, unknown> = {
    claimId: claim.id,
    answer: worker.answer,
    confidence: worker.confidence,
    reasoning: worker.reasoning,
    correctedTo: review.correctedTo,
    reviewerNote: review.note,
    difficulty: claim.difficulty ?? null,
    label: claim.label,
  };
  if (claim.task === "approve") {
    const i = claim.input;
    base.decision = worker.answer;
    base.inputSummary = `${i.description} — ${i.facts}`;
    base.humanOverride = review.wasOverridden
      ? {
          overrodeTo: review.correctedTo ?? (String(worker.answer).toUpperCase() === "DENY" ? "APPROVE" : "DENY"),
          by: "Reviewer Agent (Sonnet 4.6)",
          note: review.note,
        }
      : null;
  }
  return base;
}

async function processClaim(claim: Claim, targets: Targets, cost: CostAcc) {
  const target = targets.tasks[claim.task];
  const taskName = TASK_NAME[claim.task];

  const worker = await runWorker(claim);
  const review = await runReviewer(claim, worker);
  const escalated = worker.confidence < (ESCALATION_THRESHOLD[taskName] ?? 0.5);

  cost.agentIn += worker.inputTokens;
  cost.agentOut += worker.outputTokens;
  cost.reviewerIn += review.inputTokens;
  cost.reviewerOut += review.outputTokens;
  cost.workerCount += 1;

  const workerTokens = worker.inputTokens + worker.outputTokens;
  await provable.track({
    agentId: target.agentId,
    taskId: target.taskId,
    outcome: worker.outcome.toLowerCase() as "success" | "failure" | "partial",
    confidence: worker.confidence,
    wasOverridden: review.wasOverridden,
    wasEscalated: escalated,
    latencyMs: worker.latencyMs,
    tokens: workerTokens,
    metadata: buildMetadata(claim, worker, review),
  });

  const ansStr = typeof worker.answer === "string" ? worker.answer : JSON.stringify(worker.answer);
  console.log(
    `  [${claim.id}] ${claim.task.padEnd(10)} ans=${String(ansStr).slice(0, 14).padEnd(14)} ${worker.outcome.padEnd(7)} conf=${worker.confidence.toFixed(2)} ovr=${review.wasOverridden ? "Y" : "n"} esc=${escalated ? "Y" : "n"} tok=${workerTokens}`,
  );
}

function printCost(cost: CostAcc) {
  const agentCost = costUsd("agent", cost.agentIn, cost.agentOut);
  const reviewerCost = costUsd("reviewer", cost.reviewerIn, cost.reviewerOut);
  const total = agentCost + reviewerCost;
  console.log("\n— Token & cost summary —");
  console.log(`  Worker  (${AGENT_MODEL}): in=${cost.agentIn} out=${cost.agentOut}  ${usd(agentCost)}`);
  console.log(`  Reviewer(Sonnet 4.6):   in=${cost.reviewerIn} out=${cost.reviewerOut}  ${usd(reviewerCost)}`);
  console.log(`  Decisions processed: ${cost.workerCount}`);
  console.log(`  TOTAL: ${usd(total)}   (${cost.workerCount > 0 ? usd(total / cost.workerCount) : "$0"} per decision)`);
}

async function waitForRecompute(ms = 4000) {
  await sleep(ms);
}

// ---------------------------------------------------------------------------
async function warmup(flags: ReturnType<typeof parseFlags>) {
  const targets = await resolveTargets();
  let claims = loadClaims();
  if (flags.limit && flags.limit > 0) claims = claims.slice(0, flags.limit);

  console.log(`Warm-up: processing ${claims.length} claims via real agents…\n`);
  const cost = newCost();
  for (const claim of claims) {
    await processClaim(claim, targets, cost);
  }

  console.log("\nWaiting for BullMQ recompute to settle…");
  await waitForRecompute();

  console.log("\n— Earned readiness per task (Claims Triage Agent) —");
  const scores = await taskScores(targets.triageId);
  for (const s of scores) {
    console.log(`  ${s.name.padEnd(32)} ${String(s.score).padStart(3)} / ${String(s.mode).padEnd(8)} (${s.eventCount} decisions)`);
  }
  printCost(cost);
}

// ---------------------------------------------------------------------------
async function live(flags: ReturnType<typeof parseFlags>) {
  const targets = await resolveTargets();
  const task: TaskKey = flags.task ?? "duplicate";
  const count = flags.count ?? 5;
  const taskName = TASK_NAME[task];

  const before = (await taskScores(targets.triageId)).find((s) => s.name === taskName);
  console.log(`Live: ${count} fresh "${taskName}" decisions by real agents.`);
  console.log(`  before: ${before?.score}/${before?.mode} (${before?.eventCount} decisions)\n`);

  const pool = loadClaims().filter((c) => c.task === task);
  const claims = pool.slice(0, Math.min(count, pool.length));
  const cost = newCost();
  for (const claim of claims) {
    await processClaim(claim, targets, cost);
  }

  console.log("\nWaiting for BullMQ recompute…");
  await waitForRecompute(3500);
  const after = (await taskScores(targets.triageId)).find((s) => s.name === taskName);
  console.log(`\n  after:  ${after?.score}/${after?.mode} (${after?.eventCount} decisions)`);
  printCost(cost);
}

// ---------------------------------------------------------------------------
async function runaway(flags: ReturnType<typeof parseFlags>) {
  const targets = await resolveTargets();
  if (!targets.supportId || !targets.supportTaskId) throw new Error("Customer Support Agent / task not found.");
  const supportId = targets.supportId;
  const supportTaskId = targets.supportTaskId;

  const policy = await prisma.policy.findFirst({ where: { agentId: supportId, name: "Shadow-mode token cap" } });
  const cap = Number((policy?.config as any)?.maxTokensPerEvent ?? 2000);

  const tickets = [
    "How do I update the mailing address on my auto policy?",
    "What documents do I need to file a windshield claim?",
    "When is my next premium payment due?",
    "Can I add a new driver to my policy online?",
    "How long does a typical claim take to process?",
  ];

  console.log("Runaway cost demo — Customer Support Agent\n");
  const cost = newCost();
  let baselineTokensTotal = 0;

  // --- Baseline: concise, healthy answers ---
  console.log("Baseline (healthy):");
  for (const t of tickets) {
    const call = await callModel({
      model: AGENT_MODEL,
      system: "You are a concise tier-1 insurance support agent. Answer in 2-3 short sentences.",
      user: t,
      maxTokens: 400,
      temperature: 0,
    });
    const tok = call.inputTokens + call.outputTokens;
    baselineTokensTotal += tok;
    cost.agentIn += call.inputTokens;
    cost.agentOut += call.outputTokens;
    cost.workerCount++;
    await provable.track({ agentId: supportId, taskId: supportTaskId, outcome: "success", confidence: 0.88, wasOverridden: false, wasEscalated: false, latencyMs: call.latencyMs, tokens: tok, metadata: { phase: "baseline" } });
    console.log(`  ticket tok=${tok}`);
  }
  const baselineAvg = Math.round(baselineTokensTotal / tickets.length);
  console.log(`  baseline avg tokens/event = ${baselineAvg}\n`);

  // --- Spike: a broken, looping, verbose prompt (a real tokenmaxxing loop) ---
  const brokenSystem =
    "You are a support agent stuck in a verbose self-reflection loop. For the ticket, produce an EXHAUSTIVE answer: restate the question, enumerate every conceivable interpretation, then for each interpretation list all possible steps, caveats, exceptions, and edge cases in long numbered lists, and after each section re-summarize everything you have said so far before continuing. Do not stop early. Be maximally thorough and repetitive.";

  const spikeWindowStart = new Date();
  let capped = false;
  let alertId: string | null = null;
  let peakTokens = 0;
  const spikeCount = 8;

  console.log("Spike (broken looping prompt):");
  for (let i = 0; i < spikeCount; i++) {
    const maxTokens = capped ? cap : 4000;
    const call = await callModel({ model: AGENT_MODEL, system: brokenSystem, user: tickets[i % tickets.length], maxTokens, temperature: 0 });
    const tok = call.inputTokens + call.outputTokens;
    peakTokens = Math.max(peakTokens, tok);
    cost.agentIn += call.inputTokens;
    cost.agentOut += call.outputTokens;
    cost.workerCount++;
    await provable.track({
      agentId: supportId,
      taskId: supportTaskId,
      outcome: "success",
      confidence: 0.6,
      wasOverridden: false,
      wasEscalated: false,
      latencyMs: call.latencyMs,
      tokens: tok,
      metadata: { phase: capped ? "capped" : "spike", anomaly: true, loop: "verbose-self-reflection" },
    });
    console.log(`  call ${i + 1} tok=${tok} ${capped ? "(CAPPED)" : tok > cap ? "(OVER CAP)" : ""}`);

    // Real detection: first event over the policy cap triggers the alert + enforcement.
    if (!capped && tok > cap) {
      capped = true;
      const multiplier = +(peakTokens / Math.max(1, baselineAvg)).toFixed(1);
      const overspendUsd = costUsd("agent", cost.agentIn, cost.agentOut); // real spend so far this run
      const alert = await prisma.alert.create({
        data: {
          agentId: supportId,
          type: "RUNAWAY_COST",
          severity: "high",
          message: `Runaway token consumption detected on Customer Support Agent — ${multiplier}× baseline. Shadow-mode token cap (${cap}/event) engaged.`,
          resolved: true,
          metadata: {
            windowStart: spikeWindowStart.toISOString(),
            windowEnd: new Date().toISOString(),
            normalTokensPerEvent: baselineAvg,
            peakTokensPerEvent: peakTokens,
            spikeMultiplier: multiplier,
            tokenCapPerEvent: cap,
            efficiencyScore: Math.max(1, Math.round((baselineAvg / Math.max(1, peakTokens)) * 100)),
            estimatedOverspendUsd: +overspendUsd.toFixed(4),
            action: `Shadow-mode token cap engaged at ${cap} tokens/event; agent throttled and flagged for review.`,
            resolvedBy: "Provable Cost Governor (real-time)",
            detection: "live token-usage monitor",
          },
        },
      });
      alertId = alert.id;
      console.log(`  >>> RUNAWAY_COST alert created (${alertId}); cap enforced at ${cap} tokens/event.`);
    }
  }

  console.log("\nWaiting for recompute…");
  await waitForRecompute(3000);
  console.log(`\n— Runaway summary —`);
  console.log(`  baseline avg: ${baselineAvg} tok/event   peak: ${peakTokens} tok/event   cap: ${cap}`);
  console.log(`  alert: ${alertId ? alertId + " (RUNAWAY_COST, high, resolved)" : "NOT CREATED — spike did not exceed cap"}`);
  printCost(cost);
}

// ---------------------------------------------------------------------------
async function main() {
  const [, , mode, ...rest] = process.argv;
  const flags = parseFlags(rest);
  switch (mode) {
    case "warmup":
      await warmup(flags);
      break;
    case "live":
      await live(flags);
      break;
    case "runaway":
      await runaway(flags);
      break;
    default:
      console.error(`Unknown mode "${mode}". Use: warmup | live | runaway`);
      process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
