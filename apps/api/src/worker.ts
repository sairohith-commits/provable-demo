import { Worker } from "bullmq";
import { recomputeTaskScore } from "@provable/db";
import { connection, RECOMPUTE_QUEUE } from "./redis.js";
import type { RecomputeJob } from "./queue.js";

// Consumes recompute jobs and writes a fresh Score row — this is what makes
// the dashboard update live when /track fires.
export function startWorker() {
  const worker = new Worker<RecomputeJob>(
    RECOMPUTE_QUEUE,
    async (job) => {
      const score = await recomputeTaskScore(job.data.taskId);
      return { taskId: job.data.taskId, readinessScore: score?.readinessScore ?? null, mode: score?.mode ?? null };
    },
    { connection, concurrency: 4 },
  );

  worker.on("completed", (job, result) => {
    console.log(`[worker] recompute task=${result?.taskId} -> score=${result?.readinessScore} mode=${result?.mode}`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
