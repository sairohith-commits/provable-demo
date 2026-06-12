import { config } from "dotenv";
import { resolve } from "node:path";

// Single root .env shared by packages/db and apps/api / apps/gateway.
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerProxyRoutes } from "./proxy.js";
import { LOG_REDACT_PATHS } from "./sanitize.js";

// Defence in depth: pino strips the provider/org credentials from any logged
// object (incl. Fastify's default request logging) before it is serialized, so
// authorization / x-api-key / x-provable-key can never reach a log sink.
const app = Fastify({
  logger: { redact: { paths: LOG_REDACT_PATHS, remove: true } },
});

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["content-type", "x-provable-key", "x-provable-agent", "x-api-key", "authorization", "anthropic-version", "anthropic-beta"],
});

app.get("/health", async () => ({ ok: true, service: "provable-gateway" }));
await registerProxyRoutes(app);

// Render (and most PaaS) inject PORT; fall back to GATEWAY_PORT for local dev.
const port = Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 4001);

try {
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Provable gateway listening on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
