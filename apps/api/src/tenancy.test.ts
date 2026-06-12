import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import assert from "node:assert/strict";
import Fastify from "fastify";
import { prisma, generateApiKey } from "@provable/db";
import { registerRoutes } from "./routes.js";
import { recomputeQueue } from "./queue.js";
import { connection } from "./redis.js";

// Endpoint-level tenant isolation, exercised through the real route handlers via
// Fastify app.inject() (no network). Seeds two orgs (A, B), each with an
// agent/task/event, then proves Org A's key returns ONLY Org A's
// agents/alerts/roi/tokens/audit — never Org B's — plus the 401 auth shapes.

const TAG = `api-tenancy-${Date.now()}`;
let pass = 0;
const ok = (l: string) => { pass++; console.log(`PASS  ${l}`); };

async function seedOrg(name: string) {
  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  const org = await prisma.org.create({ data: { name: `${TAG}-${name}`, apiKeyHash, apiKeyPrefix } });
  const agent = await prisma.agent.create({ data: { orgId: org.id, name: `${TAG}-agent-${name}`, purpose: "p" } });
  const task = await prisma.task.create({ data: { agentId: agent.id, name: "t", key: `${TAG}-key`, riskLevel: "low" } });
  const event = await prisma.event.create({
    data: { agentId: agent.id, taskId: task.id, outcome: "SUCCESS", confidence: 0.9, tokens: 100 },
  });
  await prisma.alert.create({ data: { agentId: agent.id, type: "RUNAWAY_COST", severity: "high", message: `${name} alert` } });
  return { org, agent, task, event, fullKey };
}

async function main() {
  const app = Fastify();
  await registerRoutes(app);
  await app.ready();

  const A = await seedOrg("A");
  const B = await seedOrg("B");
  const keyA = { "x-provable-key": A.fullKey };

  const json = (r: { payload: string }) => JSON.parse(r.payload);

  // --- auth shapes ---
  assert.equal((await app.inject({ method: "GET", url: "/agents" })).statusCode, 401);
  ok("auth: no key -> 401");
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: { "x-provable-key": "garbage" } });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "missing_or_malformed_key");
    ok("auth: malformed key -> 401 missing_or_malformed_key");
  }
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: { "x-provable-key": "pk_live_does_not_exist" } });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "invalid_key");
    ok("auth: unknown key -> 401 invalid_key");
  }

  // --- /agents list scoped ---
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: keyA });
    assert.equal(r.statusCode, 200);
    const agents = json(r) as Array<{ id: string }>;
    assert.ok(agents.some((a) => a.id === A.agent.id), "Org A agent present");
    assert.ok(!agents.some((a) => a.id === B.agent.id), "Org B agent ABSENT");
    ok("/agents: Org A key returns only Org A's agents");
  }

  // --- cross-org access to Org B's resources with Org A's key -> 404 (not found in A's scope) ---
  for (const [label, url] of [
    ["detail", `/agents/${B.agent.id}`],
    ["alerts", `/agents/${B.agent.id}/alerts`],
    ["roi", `/agents/${B.agent.id}/roi`],
    ["tokens", `/agents/${B.agent.id}/tokens`],
    ["audit", `/tasks/${B.task.id}/audit`],
  ] as const) {
    const r = await app.inject({ method: "GET", url, headers: keyA });
    assert.equal(r.statusCode, 404, `${label} on Org B resource with Org A key must 404`);
    ok(`/${label}: Org A key cannot read Org B's resource (404)`);
  }

  // --- and Org A's own resources resolve cleanly with Org A's key ---
  {
    const r = await app.inject({ method: "GET", url: `/agents/${A.agent.id}/alerts`, headers: keyA });
    assert.equal(r.statusCode, 200);
    const alerts = json(r) as Array<{ message: string }>;
    assert.ok(alerts.every((a) => !a.message.startsWith("B ")), "no Org B alert leaked");
    ok("/alerts: Org A key returns its own alerts, none of Org B's");

    const audit = await app.inject({ method: "GET", url: `/tasks/${A.task.id}/audit`, headers: keyA });
    assert.equal(audit.statusCode, 200);
    assert.equal(json(audit).events.length, 1, "Org A sees exactly its own event");
    ok("/audit: Org A key returns only its own task's events");
  }

  // --- /org/key returns the display PREFIX only, never a usable key ---
  {
    const r = await app.inject({ method: "GET", url: "/org/key", headers: keyA });
    assert.equal(r.statusCode, 200);
    const body = json(r);
    assert.equal(body.apiKeyPrefix, A.org.apiKeyPrefix, "prefix returned");
    assert.equal(body.apiKey, undefined, "no full apiKey field");
    assert.ok(!JSON.stringify(body).includes(A.fullKey), "full key never present in response");
    ok("/org/key: returns apiKeyPrefix only, never the full key");
  }

  await app.close();
  console.log(`\n${pass} checks passed.`);
}

main()
  .catch((e) => { console.error("FAIL", e); process.exitCode = 1; })
  .finally(async () => {
    await prisma.alert.deleteMany({ where: { agent: { name: { startsWith: `${TAG}-agent-` } } } });
    await prisma.event.deleteMany({ where: { task: { key: `${TAG}-key` } } });
    await prisma.task.deleteMany({ where: { key: `${TAG}-key` } });
    await prisma.agent.deleteMany({ where: { name: { startsWith: `${TAG}-agent-` } } });
    await prisma.org.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
    await prisma.$disconnect();
    await recomputeQueue.close();
    await connection.quit();
  });
