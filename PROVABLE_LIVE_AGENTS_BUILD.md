# Provable — Phase 9: Live Agents (Build Spec)

> **Purpose.** Replace seeded telemetry with **real agents doing real work**. Build agents that perform claims tasks via the Anthropic API, judge their own outcomes against labeled data, generate real overrides via a reviewer agent, capture real tokens/cost, and stream every decision into Provable through `@provable/sdk`. The existing scoring engine, API, worker, and dashboard are unchanged — they now display earned data instead of seeded data.
>
> **Prereq.** The Phase 1–8 build is complete and running. This is additive. Hand this file to Claude Code.

---

## 0. What changes vs. the seeded demo

- `db:seed` is split: a **structure seed** creates the org, agents, tasks, and policies with **zero events**. Events now come from real agent runs.
- A new app, `apps/agents`, runs the worker + reviewer agents and emits events via the SDK.
- Scores are **earned, not engineered**. We control *band separation* (Solo / Co-Pilot / Shadow) by tuning task difficulty and tolerances — never by faking outcomes.
- Cost, tokens, latency, and ROI become **real** (from the Anthropic API response).

---

## 1. New dependencies & env

- Add `@anthropic-ai/sdk` to `apps/agents`.
- Env (add to root `.env`):
  ```
  ANTHROPIC_API_KEY=sk-ant-...
  AGENT_MODEL=claude-haiku-4-5-20251001        # fast + cheap for the worker
  REVIEWER_MODEL=claude-sonnet-4-6             # stronger critic for overrides
  ```
  (Use current model strings; confirm against the Anthropic docs. Haiku for the worker keeps a 200-claim warm-up to cents.)

---

## 2. Structure seed (`packages/db`)

Add `db:seed:structure` — creates, with **no events**:
- Org "Atlas Insurance"
- Agent "Claims Triage Agent" with four tasks: **Categorize claim** (low), **Estimate payout** (medium), **Approve / deny claim** (high), **Flag potential duplicate claim** (medium)
- Agent "Customer Support Agent" (for the cost/runaway beat)
- Policies (escalation thresholds — see §5)

The agent runner resolves agent/task IDs **by name** at runtime, so no hardcoded IDs.

---

## 3. Labeled dataset (`apps/agents/data/claims.json`)

Curated claims with ground-truth labels, tagged by task and difficulty. Difficulty is the only lever for band separation — outcomes are never overridden by hand.

Each record:
```json
{
  "id": "C-1042",
  "task": "categorize",                  // categorize | estimate | approve | duplicate
  "input": { "description": "...", "amount": 4200, "history": "..." },
  "label": "auto_collision",             // ground truth (category | number | APPROVE/DENY | bool)
  "tolerance": 0.10                       // for estimate: success if within ±10% of label
}
```

Dataset design (this is what makes the bands reliable):
- **Categorize (~Solo):** ~60 clean, unambiguous claims with obvious categories. LLM scores high.
- **Estimate payout (~Co-Pilot):** ~60 claims with messy inputs; success = within `tolerance` (start 0.10). Lands mid.
- **Approve/deny (~Shadow):** ~60 deliberately ambiguous / edge-case claims, strict correctness, paired with an aggressive reviewer. Lands low.
- **Duplicate (~Co-Pilot, the live beat):** ~20 claims only, so its window is small and a live batch visibly moves the score.

---

## 4. Worker agent (`apps/agents/src/worker.ts`)

One function per task. Each:
1. Builds a task-specific prompt with the claim input.
2. Calls the Anthropic API (`AGENT_MODEL`), instructing the model to return strict JSON: `{ "answer": ..., "confidence": 0.0-1.0, "reasoning": "..." }`.
3. Parses it, times the call (`latencyMs`), and reads `response.usage` for `tokens` (input + output).
4. Judges **outcome** against the label:
   - categorize / approve / duplicate: exact match → SUCCESS, else FAILURE
   - estimate: within `tolerance` → SUCCESS; within 2× tolerance → PARTIAL; else FAILURE

Return `{ answer, confidence, reasoning, outcome, tokens, latencyMs }`.

---

## 5. Reviewer agent + escalation (`apps/agents/src/reviewer.ts`)

- **Reviewer** (`REVIEWER_MODEL`): given the task, claim, and the worker's answer + reasoning, it acts as a senior adjuster and returns `{ "agree": bool, "correctedTo": ..., "note": "..." }`. If `agree === false` → `wasOverridden = true`. The reviewer is naturally stricter on ambiguous tasks, so override rate rises with difficulty — exactly the real behavior we want.
- **Escalation:** `wasEscalated = confidence < escalationThreshold` for that task (from the policy). Defaults: categorize 0.40, estimate 0.55, approve 0.65, duplicate 0.50. (Higher-risk tasks escalate more readily.)

---

## 6. The track call

For each processed claim, send via `@provable/sdk`:
```ts
await provable.track({
  agentId, taskId,
  outcome,                 // from worker judging
  confidence,              // model self-report
  wasOverridden,           // from reviewer
  wasEscalated,            // from confidence threshold
  latencyMs,               // real
  tokens,                  // real, from usage
  metadata: { claimId, answer, correctedTo, reasoning, reviewerNote }  // powers the audit log
});
```
The existing `/track` → BullMQ worker → score recompute path handles the rest. The audit log reads `metadata`, so denials now carry a **real** decision trail.

---

## 7. Runner commands (`apps/agents/package.json`)

- `pnpm agents:warmup` — process the **full** dataset (~200 claims). Builds real history; produces the earned baseline scores. Run this the morning of the demo.
- `pnpm agents:live` — process a **small fresh batch** (default 5) against a chosen task (default: duplicate). This is the on-stage live beat — real decisions arrive, the score recomputes live.
- `pnpm agents:runaway` — run the Support Agent with a deliberately broken, verbose looping prompt for N calls so token usage spikes ~9×, triggering Provable's **real** Runaway Cost Detection alert. Cap enforced by policy.

Each command prints, per claim: task, answer, outcome, confidence, overridden?, escalated?, tokens. At the end, `agents:warmup` prints the resulting readiness score + mode per task.

---

## 8. Keeping the bands reliable (tuning, not faking)

After `agents:warmup`, if a task lands in the wrong band, tune **inputs**, never outcomes:
- Score too high on Estimate → tighten `tolerance` (0.10 → 0.07).
- Approve/deny not low enough → add more ambiguous edge cases, or raise reviewer strictness in its prompt.
- Categorize not reaching Solo → remove the few genuinely ambiguous categorize claims.
Re-run warm-up until the three tasks sit clearly in **Solo / Co-Pilot / Shadow**. Exact values will vary run to run — that's expected and honest.

---

## 9. Demo flow with live agents

1. **Morning of:** `pnpm agents:warmup`. Read the real scores; note them for your talk track.
2. **On stage:** walk the dashboard (registry → three earned verdicts → trend).
3. **Live beat:** run `pnpm agents:live` → real agents process new duplicate-claim decisions → refresh → the task's score recomputes from real activity. "These are live agents, deciding right now."
4. **Cost beat:** run `pnpm agents:runaway` → watch Provable catch and cap a **real** token spike.
5. **ROI / audit:** ROI is computed from real token cost; the audit log shows a real denial with the worker's reasoning and the reviewer's override.

---

## 10. Acceptance criteria — "live agents ready when"

- `pnpm db:seed:structure` creates org/agents/tasks with **zero** events.
- `pnpm agents:warmup` processes the dataset via real Anthropic API calls, judges outcomes against labels, generates overrides via the reviewer, and emits one tracked event per claim with **real** tokens/latency.
- After warm-up, the four tasks read distinct, earned scores landing in **Solo / Co-Pilot / Shadow / Co-Pilot** bands (values will vary; bands must hold).
- `pnpm agents:live` produces a visible score recompute on the duplicate task from real decisions.
- `pnpm agents:runaway` produces a real RUNAWAY_COST alert from genuine token usage.
- ROI and audit screens reflect real cost and real decision trails.

---

## 11. Out of scope

Real human reviewers (the reviewer agent stands in), production claim systems, and any change to the scoring formula, API, or dashboard beyond reading real data. Keep the dataset small enough that a full warm-up costs cents, not dollars.
