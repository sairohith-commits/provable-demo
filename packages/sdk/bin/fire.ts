import { Provable } from "../src/index.js";

// demo:fire — the live demo beat. Sends a small burst of strong-success events
// to the recently-deployed "Flag potential duplicate claim" task. This task sits
// just under the SOLO threshold (67/COPILOT) on a deliberately small evidence
// window, so the burst pushes its rolling readiness across 71 -> SOLO: a visible,
// honest "more evidence arrived" mode flip rather than magic.
//
// Defaults: 5 events at confidence 0.95. Override the count via `pnpm demo:fire 8`.
const API = process.env.API_URL ?? "http://localhost:4000";
const TARGET_TASK = "Flag potential duplicate claim";
const count = Math.max(1, Math.floor(Number(process.argv[2] ?? 5)) || 5);
const FIRE_CONF = 0.95;

interface AgentDto {
  id: string;
  name: string;
  tasks: Array<{ id: string; name: string; latestScore: { readinessScore: number; mode: string; eventCount: number } | null }>;
}

async function readTask(): Promise<{ agentId: string; taskId: string; score: number | null; mode: string | null; eventCount: number | null }> {
  const agents = (await (await fetch(`${API}/agents`)).json()) as AgentDto[];
  const triage = agents.find((a) => a.name === "Claims Triage Agent");
  const task = triage?.tasks.find((t) => t.name === TARGET_TASK);
  if (!triage || !task) throw new Error(`Could not find "${TARGET_TASK}" on the Claims Triage Agent. Is the API seeded and running?`);
  return {
    agentId: triage.id,
    taskId: task.id,
    score: task.latestScore?.readinessScore ?? null,
    mode: task.latestScore?.mode ?? null,
    eventCount: task.latestScore?.eventCount ?? null,
  };
}

async function main() {
  const before = await readTask();
  console.log(`${TARGET_TASK}`);
  console.log(`  before:  score=${before.score}  mode=${before.mode}  eventCount=${before.eventCount}`);

  const provable = new Provable({ apiUrl: API, apiKey: "demo" });
  for (let i = 0; i < count; i++) {
    await provable.track({
      agentId: before.agentId,
      taskId: before.taskId,
      outcome: "success",
      confidence: FIRE_CONF,
      wasOverridden: false,
      wasEscalated: false,
      tokens: 1050,
    });
  }
  console.log(`  fired:   ${count} strong-success event${count > 1 ? "s" : ""} via @provable/sdk -> POST /track (recompute queued)`);

  // Wait for the BullMQ worker to write the fresh Score row.
  let after = before;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const now = await readTask();
    if (now.eventCount !== before.eventCount && now.score !== before.score) {
      after = now;
      break;
    }
    after = now;
  }
  console.log(`  after:   score=${after.score}  mode=${after.mode}  eventCount=${after.eventCount}`);

  const crossed = (before.mode === "COPILOT" || (before.score ?? 0) <= 70) && after.mode === "SOLO";
  console.log(crossed ? `\n  ✓ LIVE BEAT: ${before.score}/COPILOT -> ${after.score}/SOLO — crossed the 71 SOLO threshold.` : `\n  (score moved ${before.score} -> ${after.score}; mode ${before.mode} -> ${after.mode})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
