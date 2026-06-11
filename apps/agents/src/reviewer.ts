import { callModel, extractJson } from "./anthropic.js";
import { REVIEWER_MODEL } from "./env.js";
import type { Claim } from "./dataset.js";
import type { WorkerResult } from "./worker.js";

export interface ReviewResult {
  agree: boolean;
  correctedTo: string | number | boolean | null;
  note: string;
  wasOverridden: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

function claimText(claim: Claim): string {
  const i = claim.input;
  switch (claim.task) {
    case "categorize":
      return `Claim: ${i.description}`;
    case "estimate":
      return `Loss: ${i.description}\nFacts: ${i.facts}`;
    case "approve":
      return `Claim: ${i.description}\nFacts: ${i.facts}`;
    case "duplicate":
      return `New claim: ${i.newClaim}\nPrior claim: ${i.priorClaim}`;
  }
}

const SYSTEM = `You are a SENIOR claims adjuster auditing a junior agent. Work each problem yourself and hold a high bar.
- ESTIMATE: independently recompute the net payout from the facts. DISAGREE if the agent is off by more than ~3%, and put your number in correctedTo.
- APPROVE/DENY: these claims usually CANNOT be resolved from the text alone — the true outcome depends on investigation the agent cannot perform, and surface appearances are often misleading. Treat the agent's call as unreliable. AGREE only when its decision is the obviously safe one on the limited facts; otherwise DISAGREE and give the call you would escalate with.
- DUPLICATE: this detector is newly deployed and NOT yet trusted to auto-clear, because mistakes here either double-pay a claim or wrongly reject a legitimate supplement. POLICY: route every borderline same-party / same-period pair to a human — that means you DISAGREE (flag for human confirmation) whenever the two records share the same claimant, policy, property, or loss date and could plausibly be related: supplements, corrected resubmissions, reopened files, recoverable-depreciation releases, recurring losses, multi-reporter filings, and name/date/wording variants all get flagged, regardless of how confident the agent is. AGREE only when the two claims are plainly UNRELATED (clearly different incidents, parties, or periods) or a trivially exact, already-paid duplicate.
When in doubt, DISAGREE.
Respond ONLY with JSON: {"agree":true|false,"correctedTo":<your corrected answer, or null if you agree>,"note":"<one sentence>"}.`;

export async function runReviewer(claim: Claim, worker: WorkerResult): Promise<ReviewResult> {
  const user = `Task: ${claim.task}
${claimText(claim)}

Agent answer: ${JSON.stringify(worker.answer)}
Agent confidence: ${worker.confidence}
Agent reasoning: ${worker.reasoning}

Do you agree with the agent's answer?`;

  const call = await callModel({
    model: REVIEWER_MODEL,
    system: SYSTEM,
    user,
    maxTokens: 400,
    temperature: 0,
    disableThinking: true,
  });

  try {
    const parsed = extractJson<{ agree: any; correctedTo?: any; note?: any }>(call.text);
    const agree = parsed.agree === true || String(parsed.agree).toLowerCase() === "true";
    return {
      agree,
      correctedTo: agree ? null : parsed.correctedTo ?? null,
      note: String(parsed.note ?? "").slice(0, 400),
      wasOverridden: !agree,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
    };
  } catch {
    // If the reviewer's output is unparseable, treat as agreement (no override) — conservative.
    return {
      agree: true,
      correctedTo: null,
      note: `UNPARSEABLE: ${call.text.slice(0, 120)}`,
      wasOverridden: false,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
    };
  }
}
