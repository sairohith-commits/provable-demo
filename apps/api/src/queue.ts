import { Queue } from "bullmq";
import { connection, RECOMPUTE_QUEUE } from "./redis.js";

export interface RecomputeJob {
  taskId: string;
}

export const recomputeQueue = new Queue<RecomputeJob>(RECOMPUTE_QUEUE, { connection });

export async function enqueueRecompute(taskId: string) {
  await recomputeQueue.add("recompute", { taskId }, { removeOnComplete: 100, removeOnFail: 100 });
}
