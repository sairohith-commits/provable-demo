import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import assert from "node:assert/strict";
import { prisma, prismaScoped, generateApiKey, hashApiKey } from "./index.js";

// Tenant-isolation + key-resolution tests. Seeds two throwaway orgs (A and B),
// each with an agent/task/event, and proves:
//   1. the tenant guard throws on unscoped Agent/Task/Event bulk reads,
//   2. org resolution by apiKeyHash maps a key to exactly its org,
//   3. org-scoped reads return ZERO of the other org's rows.
// Uses the BASE client for setup/teardown (deleteMany is itself guarded) and the
// GUARDED client for the assertions a request handler would issue.

const TAG = `tenancy-test-${Date.now()}`;
let pass = 0;
function ok(label: string) {
  pass++;
  console.log(`PASS  ${label}`);
}

async function seedOrg(name: string) {
  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  const org = await prisma.org.create({ data: { name: `${TAG}-${name}`, apiKeyHash, apiKeyPrefix } });
  const agent = await prisma.agent.create({ data: { orgId: org.id, name: `${TAG}-agent-${name}`, purpose: "p" } });
  const task = await prisma.task.create({ data: { agentId: agent.id, name: "t", key: `${TAG}-key`, riskLevel: "low" } });
  const event = await prisma.event.create({ data: { agentId: agent.id, taskId: task.id, outcome: "SUCCESS", confidence: 0.9 } });
  return { org, agent, task, event, fullKey };
}

async function main() {
  const A = await seedOrg("A");
  const B = await seedOrg("B");

  // 1. Guard throws on unscoped bulk reads of each tenant model.
  await assert.rejects(
    () => prismaScoped.agent.findMany({ where: {} }),
    /tenant scope missing on Agent\.findMany/,
    "agent.findMany({where:{}}) must throw",
  );
  ok("guard: agent.findMany({ where: {} }) throws tenant-scope error");

  await assert.rejects(() => (prismaScoped.agent as any).findMany(), /tenant scope missing on Agent\.findMany/);
  ok("guard: agent.findMany() (no args) throws");

  await assert.rejects(() => prismaScoped.task.findMany({ where: {} }), /tenant scope missing on Task\.findMany/);
  ok("guard: task.findMany({ where: {} }) throws");

  await assert.rejects(() => prismaScoped.event.findMany({ where: {} }), /tenant scope missing on Event\.findMany/);
  ok("guard: event.findMany({ where: {} }) throws");

  await assert.rejects(() => prismaScoped.agent.count({ where: {} }), /tenant scope missing on Agent\.count/);
  ok("guard: agent.count({ where: {} }) throws");

  // Scoped reads are allowed.
  const scopedAgents = await prismaScoped.agent.findMany({ where: { orgId: A.org.id } });
  ok("guard: agent.findMany({ where: { orgId } }) allowed");
  // Event scoped by its parent FK (Event has no orgId column) is allowed.
  await prismaScoped.event.findMany({ where: { taskId: A.task.id } });
  ok("guard: event.findMany({ where: { taskId } }) allowed");

  // findUnique by primary id is allowed (single-row lookup).
  await prismaScoped.agent.findUnique({ where: { id: A.agent.id } });
  ok("guard: agent.findUnique({ where: { id } }) allowed");

  // 2. Key resolution by apiKeyHash.
  const resolvedA = await prisma.org.findUnique({ where: { apiKeyHash: hashApiKey(A.fullKey) } });
  assert.equal(resolvedA?.id, A.org.id, "Org A key resolves to Org A");
  const resolvedB = await prisma.org.findUnique({ where: { apiKeyHash: hashApiKey(B.fullKey) } });
  assert.equal(resolvedB?.id, B.org.id, "Org B key resolves to Org B");
  ok("resolver: each key resolves to exactly its own org");

  const invalid = await prisma.org.findUnique({ where: { apiKeyHash: hashApiKey("pk_live_not_a_real_key") } });
  assert.equal(invalid, null, "invalid key resolves to null");
  ok("resolver: invalid key resolves to null");

  // 3. Org A's scoped reads return ZERO of Org B's rows.
  assert.ok(scopedAgents.every((a) => a.orgId === A.org.id), "only Org A agents");
  assert.ok(!scopedAgents.some((a) => a.id === B.agent.id), "Org B agent absent from Org A scope");
  ok("isolation: Org A agent scope excludes Org B's agent");

  const aTasks = await prismaScoped.task.findMany({ where: { agentId: A.agent.id } });
  assert.ok(!aTasks.some((t) => t.id === B.task.id), "Org B task absent");
  const aEvents = await prismaScoped.event.findMany({ where: { agentId: A.agent.id } });
  assert.ok(!aEvents.some((e) => e.id === B.event.id), "Org B event absent");
  ok("isolation: Org A task/event scope excludes Org B's rows");

  console.log(`\n${pass} checks passed.`);
}

main()
  .catch((e) => {
    console.error("FAIL", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Teardown via base client (deleteMany is guarded on prismaScoped).
    await prisma.event.deleteMany({ where: { task: { key: `${TAG}-key` } } });
    await prisma.task.deleteMany({ where: { key: `${TAG}-key` } });
    await prisma.agent.deleteMany({ where: { name: { startsWith: `${TAG}-agent-` } } });
    await prisma.org.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
    await prisma.$disconnect();
  });
