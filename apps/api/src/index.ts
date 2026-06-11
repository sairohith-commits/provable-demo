import { config } from "dotenv";
import { resolve } from "node:path";

// Single root .env shared by packages/db and apps/api.
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./routes.js";
import { startWorker } from "./worker.js";

const app = Fastify({ logger: true });
// Allow all origins (incl. /register and /track) so external agents anywhere can
// enroll and report. The x-provable-key header remains the auth gate.
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["content-type", "x-provable-key", "x-provable-agent"],
});

app.get("/health", async () => ({ ok: true, service: "provable-api" }));
await registerRoutes(app);

// Run the BullMQ recompute worker in-process so `pnpm dev` starts everything.
const worker = startWorker();

// Render (and most PaaS) inject PORT; fall back to API_PORT for local dev.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);

try {
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Provable API listening on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown() {
  await worker.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
