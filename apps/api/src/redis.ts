import IORedis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

// BullMQ requires maxRetriesPerRequest: null on the shared connection.
export const connection = new IORedis(url, { maxRetriesPerRequest: null });

export const RECOMPUTE_QUEUE = "recompute";
