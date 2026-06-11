import { prisma } from "./client.js";
import { readinessScore, modeForScore } from "./scoring.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Aggregate a task's events over a rolling 30-day window, compute the four
 * sub-rates and the readiness score, then write a fresh Score row.
 * This is the shared logic used by both the seed and the BullMQ worker.
 */
export async function recomputeTaskScore(taskId: string, now: Date = new Date()) {
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);

  const events = await prisma.event.findMany({
    where: { taskId, createdAt: { gte: since, lte: now } },
    select: { outcome: true, confidence: true, wasOverridden: true, wasEscalated: true },
  });

  const total = events.length;
  if (total === 0) {
    return null;
  }

  let successes = 0;
  let confidenceSum = 0;
  let overridden = 0;
  let escalated = 0;

  for (const e of events) {
    if (e.outcome === "SUCCESS") successes++;
    confidenceSum += e.confidence;
    if (e.wasOverridden) overridden++;
    if (e.wasEscalated) escalated++;
  }

  const accuracyRate = successes / total;
  const confidenceAvg = confidenceSum / total;
  const overrideRate = overridden / total;
  const escalationRate = escalated / total;

  const score = readinessScore({ accuracyRate, confidenceAvg, overrideRate, escalationRate });
  const mode = modeForScore(score);

  return prisma.score.create({
    data: {
      taskId,
      accuracyRate,
      confidenceAvg,
      overrideRate,
      escalationRate,
      readinessScore: score,
      mode,
      eventCount: total,
      calculatedAt: now,
    },
  });
}
