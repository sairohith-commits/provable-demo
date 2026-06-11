import assert from "node:assert/strict";
import { readinessScore, modeForScore } from "./scoring.js";

// The three target tasks from §6, using the per-task aggregate rates.
const cases = [
  { name: "Categorize claim", in: { accuracyRate: 0.95, confidenceAvg: 0.9, overrideRate: 0.05, escalationRate: 0.03 }, score: 94, mode: "SOLO" },
  { name: "Estimate payout", in: { accuracyRate: 0.62, confidenceAvg: 0.58, overrideRate: 0.3, escalationRate: 0.18 }, score: 66, mode: "COPILOT" },
  { name: "Approve / deny claim", in: { accuracyRate: 0.35, confidenceAvg: 0.3, overrideRate: 0.6, escalationRate: 0.45 }, score: 38, mode: "SHADOW" },
] as const;

let failed = false;
for (const c of cases) {
  const s = readinessScore(c.in);
  const m = modeForScore(s);
  const ok = s === c.score && m === c.mode;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: score=${s} (expected ${c.score}), mode=${m} (expected ${c.mode})`);
  assert.equal(s, c.score, `${c.name} score`);
  assert.equal(m, c.mode, `${c.name} mode`);
}

// Mode boundary checks.
assert.equal(modeForScore(40), "SHADOW");
assert.equal(modeForScore(41), "COPILOT");
assert.equal(modeForScore(70), "COPILOT");
assert.equal(modeForScore(71), "SOLO");

// Live-beat task crossing: 18-event window (67/COPILOT) + 5 success@0.95 -> SOLO.
const dupPre = readinessScore({ accuracyRate: 12 / 18, confidenceAvg: 0.46, overrideRate: 4 / 18, escalationRate: 2 / 18 });
const dupPost = readinessScore({ accuracyRate: 17 / 23, confidenceAvg: (0.46 * 18 + 5 * 0.95) / 23, overrideRate: 4 / 23, escalationRate: 2 / 23 });
console.log(`Duplicate-claim live beat: pre=${dupPre} (${modeForScore(dupPre)}) -> post=${dupPost} (${modeForScore(dupPost)})`);
assert.equal(dupPre, 67, "duplicate pre-fire score");
assert.equal(modeForScore(dupPre), "COPILOT", "duplicate pre-fire mode");
assert.equal(modeForScore(dupPost), "SOLO", "duplicate post-fire mode");
assert.ok(dupPost >= 71, "duplicate post-fire must cross 71");

console.log(failed ? "\nSCORING TESTS FAILED" : "\nAll scoring tests passed: 94 / 66 / 38 -> SOLO / COPILOT / SHADOW");
if (failed) process.exit(1);
