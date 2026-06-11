import { callModel, extractJson } from "./anthropic.js";
import { AGENT_MODEL } from "./env.js";
import type { Claim } from "./dataset.js";

export type Outcome = "SUCCESS" | "FAILURE" | "PARTIAL";

export interface WorkerResult {
  answer: string | number | boolean;
  confidence: number;
  reasoning: string;
  outcome: Outcome;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

const CATEGORIES = [
  "auto_collision",
  "auto_theft",
  "auto_glass",
  "property_fire",
  "property_water",
  "property_theft",
  "liability_injury",
  "medical",
  "weather_damage",
];

function prompt(claim: Claim): { system: string; user: string } {
  const i = claim.input;
  switch (claim.task) {
    case "categorize":
      return {
        system: `You are a P&C claims triage classifier. Categorize the claim into exactly ONE of: ${CATEGORIES.join(", ")}. Respond ONLY with JSON: {"answer":"<category>","confidence":<0..1>,"reasoning":"<one sentence>"}.`,
        user: `Claim: ${i.description}`,
      };
    case "estimate":
      return {
        system: `You are a claims payout estimator. Compute the NET payout in US dollars the insurer should pay, applying deductibles, depreciation, sublimits, and any noted adjustments. Respond ONLY with JSON: {"answer":<number>,"confidence":<0..1>,"reasoning":"<one sentence>"}. "answer" must be a plain number — no currency symbols or commas.`,
        user: `Loss: ${i.description}\nFacts: ${i.facts}`,
      };
    case "approve":
      return {
        system: `You are a claims adjuster deciding APPROVE or DENY. Weigh coverage, documentation quality, and fraud indicators. Respond ONLY with JSON: {"answer":"APPROVE"|"DENY","confidence":<0..1>,"reasoning":"<one sentence>"}.`,
        user: `Claim: ${i.description}\nFacts: ${i.facts}`,
      };
    case "duplicate":
      return {
        system: `You decide whether a NEW claim is a DUPLICATE of a PRIOR claim — i.e., the same underlying loss already on file (not merely similar, recurring, or a supplement). Respond ONLY with JSON: {"answer":true|false,"confidence":<0..1>,"reasoning":"<one sentence>"}. true means it is a duplicate.`,
        user: `New claim: ${i.newClaim}\nPrior claim: ${i.priorClaim}`,
      };
  }
}

function norm(v: unknown): string {
  return String(v).trim().toLowerCase();
}
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  return parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
}
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = norm(v);
  return s === "true" || s === "yes" || s === "duplicate" || s === "1";
}

function judge(claim: Claim, answer: string | number | boolean): Outcome {
  switch (claim.task) {
    case "categorize":
      return norm(answer) === norm(claim.label) ? "SUCCESS" : "FAILURE";
    case "approve":
      return norm(answer) === norm(claim.label) ? "SUCCESS" : "FAILURE";
    case "duplicate":
      return toBool(answer) === Boolean(claim.label) ? "SUCCESS" : "FAILURE";
    case "estimate": {
      const a = toNum(answer);
      const l = Number(claim.label);
      const tol = claim.tolerance ?? 0.1;
      if (!isFinite(a)) return "FAILURE";
      const rel = Math.abs(a - l) / Math.max(1, Math.abs(l));
      if (rel <= tol) return "SUCCESS";
      if (rel <= 2 * tol) return "PARTIAL";
      return "FAILURE";
    }
  }
}

export async function runWorker(claim: Claim): Promise<WorkerResult> {
  const { system, user } = prompt(claim);
  const call = await callModel({ model: AGENT_MODEL, system, user, maxTokens: 500, temperature: 0 });

  let parsed: { answer: any; confidence?: any; reasoning?: any };
  try {
    parsed = extractJson(call.text);
  } catch {
    // Unparseable model output counts as a failed decision (honest — not retried into a pass).
    return {
      answer: "",
      confidence: 0.0,
      reasoning: `UNPARSEABLE: ${call.text.slice(0, 120)}`,
      outcome: "FAILURE",
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
    };
  }

  // Normalize the answer per task for both judging and storage.
  let answer: string | number | boolean;
  if (claim.task === "estimate") answer = toNum(parsed.answer);
  else if (claim.task === "duplicate") answer = toBool(parsed.answer);
  else answer = String(parsed.answer).trim();

  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5)));
  const reasoning = String(parsed.reasoning ?? "").slice(0, 400);
  const outcome = judge(claim, answer);

  return {
    answer,
    confidence,
    reasoning,
    outcome,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    latencyMs: call.latencyMs,
  };
}
