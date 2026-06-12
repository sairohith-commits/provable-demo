import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { prisma, generateApiKey } from "@provable/db";
import { registerProxyRoutes } from "./proxy.js";
import { LOG_REDACT_PATHS } from "./sanitize.js";

// S3 provider-key hygiene — sentinel test.
//
// Fires a proxied /v1/messages call carrying a SENTINEL fake Anthropic key and
// proves the key is: forwarded UNCHANGED to upstream, never persisted on the
// GatewayCall row, never written to a log line (success AND error paths), and
// not carried in any queued job. The upstream fetch is stubbed so no real
// network call is made and the response can be compared byte-for-byte.

const SENTINEL = `sk-ant-SENTINEL-${Date.now()}-NEVER-PERSIST-OR-LOG`;
const TAG = `gw-hygiene-${Date.now()}`;
let pass = 0;
const ok = (l: string) => { pass++; console.log(`PASS  ${l}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Canned upstream (Anthropic) response — what the proxy must return unchanged.
const ANTHROPIC_BODY = JSON.stringify({
  id: "msg_sentinel_test",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text: "hello from the (stubbed) upstream" }],
  usage: { input_tokens: 11, output_tokens: 7 },
});

const realFetch = globalThis.fetch;
let forwarded: Record<string, string> = {};

async function main() {
  // ---- stub the upstream so we capture the forwarded headers, no real call ----
  globalThis.fetch = (async (_url: any, init: any) => {
    forwarded = {};
    const h = init?.headers;
    if (h && typeof h.forEach === "function") h.forEach((v: string, k: string) => { forwarded[k.toLowerCase()] = v; });
    return new Response(ANTHROPIC_BODY, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  // ---- capture every log line the gateway emits ----
  const logs: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, cb) { logs.push(chunk.toString()); cb(); } });
  const app = Fastify({ logger: { level: "trace", redact: { paths: LOG_REDACT_PATHS, remove: true }, stream: logStream } });
  await registerProxyRoutes(app);
  await app.ready();

  // ---- seed a throwaway org so x-provable-key resolves ----
  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  const org = await prisma.org.create({ data: { name: TAG, apiKeyHash, apiKeyPrefix } });

  const headers = {
    "content-type": "application/json",
    "x-provable-key": fullKey,
    "x-provable-agent": `${TAG}-agent`,
    authorization: `Bearer ${SENTINEL}`,
    "x-api-key": SENTINEL,
    "anthropic-version": "2023-06-01",
  };
  const payload = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });

  // ---- SUCCESS path ----
  const res = await app.inject({ method: "POST", url: "/v1/messages", headers, payload });
  assert.equal(res.statusCode, 200, "proxied call returns 200");
  ok("proxy: success call returns 200");

  // 1. forwarded UNCHANGED to upstream
  assert.equal(forwarded["authorization"], `Bearer ${SENTINEL}`, "authorization forwarded unchanged");
  assert.equal(forwarded["x-api-key"], SENTINEL, "x-api-key forwarded unchanged");
  assert.equal(forwarded["x-provable-key"], undefined, "x-provable-key NOT forwarded upstream");
  ok("forward: provider key reaches upstream unchanged; x-provable-key not forwarded");

  // response byte-for-byte unchanged
  assert.equal(res.payload, ANTHROPIC_BODY, "response body byte-for-byte unchanged");
  ok("response: returned byte-for-byte unchanged vs upstream body");

  // ---- wait for the fire-and-forget capture to persist ----
  let rows: any[] = [];
  for (let i = 0; i < 40; i++) {
    rows = await prisma.gatewayCall.findMany({ where: { orgId: org.id } });
    if (rows.length) break;
    await sleep(100);
  }
  assert.ok(rows.length >= 1, "capture wrote a GatewayCall row");
  ok("persist: cost-capture row written");

  // 2. row contains ONLY the 7 allowed fields (+ db-generated id/createdAt), no sentinel
  for (const r of rows) {
    const keys = Object.keys(r).sort();
    assert.deepEqual(
      keys,
      ["agentId", "costUsd", "createdAt", "id", "inputTokens", "latencyMs", "model", "orgId", "outputTokens"],
      "GatewayCall row has only the allowed columns",
    );
  }
  assert.ok(!JSON.stringify(rows).includes(SENTINEL), "sentinel absent from every GatewayCall row");
  ok("persist: row has only allowed fields; sentinel absent from DB");

  // ---- ERROR path: upstream throws with header material attached -> 502, sanitized log ----
  globalThis.fetch = (async () => {
    const e: any = new Error("upstream connection reset");
    // Attach auth material the way a misbehaving client lib might — must NOT be logged.
    e.config = { headers: { authorization: `Bearer ${SENTINEL}`, "x-api-key": SENTINEL } };
    e.request = { headers: { "x-api-key": SENTINEL } };
    throw e;
  }) as typeof fetch;
  const errRes = await app.inject({ method: "POST", url: "/v1/messages", headers, payload });
  assert.equal(errRes.statusCode, 502, "upstream failure surfaces as 502");
  ok("proxy: upstream failure returns 502");

  // 3. sentinel never in ANY log line (success request logging + sanitized error)
  await sleep(50);
  const allLogs = logs.join("\n");
  assert.ok(allLogs.length > 0, "logs were captured");
  assert.ok(!allLogs.includes(SENTINEL), "sentinel never appears in any log line");
  ok("logs: sentinel absent from all log lines (success + error paths)");

  // 4. no BullMQ job payload can carry it — the gateway is not a queue producer
  const gwSrc = ["proxy.ts", "capture.ts", "org.ts", "index.ts"].map((f) => readFileSync(resolve("src", f), "utf8")).join("\n");
  assert.ok(!/bullmq|enqueue|\.add\(|new Queue/i.test(gwSrc), "gateway runtime enqueues nothing");
  ok("queue: gateway produces no BullMQ jobs (no key can land in a job payload)");

  await app.close();
  console.log(`\n${pass} checks passed.`);

  // cleanup
  await prisma.gatewayCall.deleteMany({ where: { orgId: org.id } });
  await prisma.agent.deleteMany({ where: { orgId: org.id } });
  await prisma.org.delete({ where: { id: org.id } });
}

main()
  .catch((e) => { console.error("FAIL", e); process.exitCode = 1; })
  .finally(async () => {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  });
