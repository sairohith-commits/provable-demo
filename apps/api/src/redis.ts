import IORedis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

// Managed Key Value / Redis (e.g. Render) uses rediss:// TLS. ioredis enables TLS
// from the protocol; we pass an explicit tls option so BullMQ connects cleanly.
const isTls = url.startsWith("rediss://");

// BullMQ requires maxRetriesPerRequest: null on the shared connection.
export const connection = new IORedis(url, {
  maxRetriesPerRequest: null,
  ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
});

export const RECOMPUTE_QUEUE = "recompute";
