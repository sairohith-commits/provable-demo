// Anthropic per-token pricing, USD per 1M tokens (input / output).
// https://www.anthropic.com/pricing — kept approximate for demo cost estimates.
// Matched by exact model id first, then by longest known prefix, then DEFAULT.
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
};

// Fallback for unrecognized model ids — Opus-tier pricing. For a cost
// product, an unknown model should OVER-estimate spend, never under-count it.
const DEFAULT_PRICING = { input: 15, output: 75 };

function pricingForModel(model: string): { input: number; output: number } {
  if (PRICING[model]) return PRICING[model];
  // Match the longest known prefix, e.g. "claude-sonnet-4-20250514" -> "claude-sonnet-4".
  const match = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICING[match] : DEFAULT_PRICING;
}

export function costForUsage(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingForModel(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
