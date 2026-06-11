import { prisma } from "@provable/db";

// Hardcoded human-baseline assumptions (would be org config in the real product).
export const ROI_ASSUMPTIONS = {
  humanMinutesPerClaim: 12, // a human adjuster's triage time per claim
  humanLoadedHourlyUsd: 45, // fully loaded cost of an adjuster
  tokenPricePer1kUsd: 0.01, // blended model price
  agentInfraPerEventUsd: 0.002, // queue/compute overhead per event
  humanReviewMinutesPerFlag: 1.5, // review time still spent on each overridden/escalated decision
};

export async function computeRoi(agentId: string) {
  const a = ROI_ASSUMPTIONS;

  const events = await prisma.event.findMany({
    where: { agentId },
    select: { outcome: true, tokens: true, wasOverridden: true, wasEscalated: true },
  });

  const claimsProcessed = events.length;
  const resolvedOutcomes = events.filter((e) => e.outcome !== "FAILURE").length;
  const totalTokens = events.reduce((s, e) => s + (e.tokens ?? 0), 0);
  // Decisions a human still had to touch — the cost of keeping agents governed.
  const flaggedDecisions = events.filter((e) => e.wasOverridden || e.wasEscalated).length;

  const agentComputeCostUsd = (totalTokens / 1000) * a.tokenPricePer1kUsd + claimsProcessed * a.agentInfraPerEventUsd;
  const oversightCostUsd = flaggedDecisions * (a.humanReviewMinutesPerFlag / 60) * a.humanLoadedHourlyUsd;
  const agentTotalCostUsd = agentComputeCostUsd + oversightCostUsd;

  const humanCostPerClaimUsd = (a.humanMinutesPerClaim / 60) * a.humanLoadedHourlyUsd;
  const humanBaselineCostUsd = claimsProcessed * humanCostPerClaimUsd;

  // Cost per resolved claim = agent compute only (the headline efficiency number).
  const costPerResolvedOutcomeUsd = resolvedOutcomes > 0 ? agentComputeCostUsd / resolvedOutcomes : 0;
  const hoursSaved = (claimsProcessed * a.humanMinutesPerClaim) / 60;
  // Net savings is measured AFTER human oversight — so the ROI score is earned, not maxed.
  const netSavingsUsd = humanBaselineCostUsd - agentTotalCostUsd;
  const roiScore = humanBaselineCostUsd > 0 ? Math.round((netSavingsUsd / humanBaselineCostUsd) * 100) : 0;

  return {
    claimsProcessed,
    resolvedOutcomes,
    flaggedDecisions,
    costPerResolvedOutcomeUsd: round2(costPerResolvedOutcomeUsd),
    humanCostPerClaimUsd: round2(humanCostPerClaimUsd),
    humanBaselineCostUsd: round2(humanBaselineCostUsd),
    agentComputeCostUsd: round2(agentComputeCostUsd),
    oversightCostUsd: round2(oversightCostUsd),
    agentTotalCostUsd: round2(agentTotalCostUsd),
    netSavingsUsd: round2(netSavingsUsd),
    hoursSaved: Math.round(hoursSaved),
    roiScore,
    assumptions: a,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
