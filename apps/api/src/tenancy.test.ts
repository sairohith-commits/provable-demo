import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import assert from "node:assert/strict";
import Fastify from "fastify";
import { prisma, generateApiKey } from "@provable/db";
import { registerRoutes } from "./routes.js";
import { recomputeQueue } from "./queue.js";
import { connection } from "./redis.js";

// Canonical two-tenant isolation smoke (Atlas/Beta-style A vs B). Endpoint-level,
// exercised through the real route handlers via Fastify app.inject() (no network,
// no browser — fast enough to run every phase). Seeds two orgs (A, B) each with an
// agent/task/event/alert, then asserts isolation across BOTH P2 auth layers:
//
//   1. MACHINE-KEY layer (P1): x-provable-key. A's key returns only A's data; A's
//      key cannot reach B's nested resources (404); the 401 auth shapes hold.
//   2. INTERNAL-TOKEN layer (C1/P2): Authorization: Bearer PROVABLE_INTERNAL_TOKEN
//      + x-provable-org-id. org-id=A returns only A; =B only B; missing/garbage
//      token -> 401; A's org-id cannot reach B's nested resources (404); and the
//      internal branch is refused on machine-key-only routes (gateway).
//
// The WEB/CLERK-SESSION layer (session-derived x-provable-org-id) is covered by the
// C3 Playwright E2E — not reimplemented here. See the smoke:isolation scripts.

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

  // ============================================================================
  // INTERNAL-TOKEN LAYER (C1/P2) — Authorization: Bearer + x-provable-org-id.
  // The org id is the resolved Provable org id (server-derived from a Clerk
  // session in prod; here we pass the seeded ids directly to exercise the branch).
  // ============================================================================
  const TOKEN = process.env.PROVABLE_INTERNAL_TOKEN;
  assert.ok(
    typeof TOKEN === "string" && TOKEN.length > 0,
    "PROVABLE_INTERNAL_TOKEN must be set (root .env) to run the internal-token isolation layer",
  );
  const internal = (orgId: string) => ({ authorization: `Bearer ${TOKEN}`, "x-provable-org-id": orgId });

  // internal token scoped to A -> only A's agents (never B's)
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: internal(A.org.id) });
    assert.equal(r.statusCode, 200);
    const agents = json(r) as Array<{ id: string }>;
    assert.ok(agents.some((a) => a.id === A.agent.id), "Org A agent present");
    assert.ok(!agents.some((a) => a.id === B.agent.id), "Org B agent ABSENT");
    ok("internal: token + org-id=A returns only Org A's agents");
  }
  // internal token scoped to B -> only B's agents (never A's)
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: internal(B.org.id) });
    assert.equal(r.statusCode, 200);
    const agents = json(r) as Array<{ id: string }>;
    assert.ok(agents.some((a) => a.id === B.agent.id), "Org B agent present");
    assert.ok(!agents.some((a) => a.id === A.agent.id), "Org A agent ABSENT");
    ok("internal: token + org-id=B returns only Org B's agents");
  }
  // missing internal token (and no machine key) -> 401
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: { "x-provable-org-id": A.org.id } });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "missing_or_malformed_key");
    ok("internal: no token at all -> 401");
  }
  // garbage internal token -> 401 invalid_internal_token (does NOT fall back to machine-key)
  {
    const r = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { authorization: "Bearer not-the-real-token", "x-provable-org-id": A.org.id },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "invalid_internal_token");
    ok("internal: garbage token -> 401 invalid_internal_token");
  }
  // short bearer (unequal length) -> clean 401, never a RangeError 500
  {
    const r = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { authorization: "Bearer x", "x-provable-org-id": A.org.id },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "invalid_internal_token");
    ok("internal: short bearer -> 401 (no 500)");
  }
  // valid token, missing org-id header -> 401 missing_org_id
  {
    const r = await app.inject({ method: "GET", url: "/agents", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "missing_org_id");
    ok("internal: valid token, missing x-provable-org-id -> 401 missing_org_id");
  }
  // valid token, unknown org-id -> 401 invalid_org_id
  {
    const r = await app.inject({
      method: "GET",
      url: "/agents",
      headers: { authorization: `Bearer ${TOKEN}`, "x-provable-org-id": "org_does_not_exist" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "invalid_org_id");
    ok("internal: valid token, unknown org-id -> 401 invalid_org_id");
  }
  // cross-org: A's internal context cannot reach B's nested resources -> 404
  for (const [label, url] of [
    ["detail", `/agents/${B.agent.id}`],
    ["alerts", `/agents/${B.agent.id}/alerts`],
    ["roi", `/agents/${B.agent.id}/roi`],
    ["tokens", `/agents/${B.agent.id}/tokens`],
    ["audit", `/tasks/${B.task.id}/audit`],
  ] as const) {
    const r = await app.inject({ method: "GET", url, headers: internal(A.org.id) });
    assert.equal(r.statusCode, 404, `${label} on Org B resource with internal org-id=A must 404`);
    ok(`internal: org-id=A cannot read Org B's ${label} (404)`);
  }
  // A's own nested resources still resolve with internal org-id=A
  {
    const r = await app.inject({ method: "GET", url: `/agents/${A.agent.id}/alerts`, headers: internal(A.org.id) });
    assert.equal(r.statusCode, 200);
    const alerts = json(r) as Array<{ message: string }>;
    assert.ok(alerts.every((a) => !a.message.startsWith("B ")), "no Org B alert leaked");
    ok("internal: org-id=A reads its own alerts (200), none of B's");
  }
  // ingestion/gateway routes stay machine-key-only: a VALID internal token is refused
  {
    const r = await app.inject({ method: "GET", url: "/gateway/stats", headers: internal(A.org.id) });
    assert.equal(r.statusCode, 401);
    assert.equal(json(r).error, "missing_or_malformed_key");
    ok("internal: token NOT honored on machine-key-only gateway routes");
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
