// USD per 1M tokens, by role. Matches the configured models.
const PRICING = {
  agent: { in: 1.0, out: 5.0 }, // Claude Haiku 4.5
  reviewer: { in: 3.0, out: 15.0 }, // Claude Sonnet 4.6
} as const;

export type CostKind = keyof typeof PRICING;

export function costUsd(kind: CostKind, inTok: number, outTok: number): number {
  const p = PRICING[kind];
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

export function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
