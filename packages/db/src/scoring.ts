// Single source of truth for the readiness formula.
// Rates are 0–1; output is 0–100.

export function readinessScore(i: {
  accuracyRate: number;
  confidenceAvg: number;
  overrideRate: number;
  escalationRate: number;
}): number {
  const raw =
    i.accuracyRate * 0.4 +
    i.confidenceAvg * 0.25 +
    (1 - i.overrideRate) * 0.2 +
    (1 - i.escalationRate) * 0.15;
  return Math.round(raw * 100);
}

export function modeForScore(s: number): "SHADOW" | "COPILOT" | "SOLO" {
  if (s <= 40) return "SHADOW";
  if (s <= 70) return "COPILOT";
  return "SOLO";
}
