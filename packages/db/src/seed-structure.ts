import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import { prisma } from "./client.js";
import { generateApiKey } from "./apiKey.js";

// Phase 9 structure seed: org, agents, tasks, and policies with ZERO events.
// All telemetry now comes from real agent runs (apps/agents). Never mix this
// with the synthetic event seed (seed.ts).

// Escalation thresholds per task (also consumed by apps/agents at runtime).
const ESCALATION_THRESHOLDS: Record<string, number> = {
  "Categorize claim": 0.4,
  "Estimate payout": 0.96,
  "Approve / deny claim": 0.99,
  "Flag potential duplicate claim": 1.0,
};

// Stable task keys (slugs) so tasks are addressable by key, not cuid.
const TASK_KEYS: Record<string, string> = {
  "Categorize claim": "categorize_claim",
  "Estimate payout": "estimate_payout",
  "Approve / deny claim": "approve_deny",
  "Flag potential duplicate claim": "flag_duplicate",
  "Resolve support ticket": "resolve_ticket",
};

async function main() {
  console.log("Resetting database (structure seed — zero events)…");
  await prisma.score.deleteMany();
  await prisma.event.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.task.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.org.deleteMany();

  // Generate a real, full-entropy key. Only the hash + display prefix are
  // stored; the full key is printed once below and is unrecoverable thereafter.
  const { fullKey, apiKeyHash, apiKeyPrefix } = generateApiKey();
  const org = await prisma.org.create({ data: { name: "Atlas Insurance", apiKeyHash, apiKeyPrefix } });

  const triage = await prisma.agent.create({
    data: {
      orgId: org.id,
      name: "Claims Triage Agent",
      purpose: "Triages inbound P&C claims: categorize, estimate, recommend approve/deny, and flag duplicates.",
    },
  });

  const tasks = [
    { name: "Categorize claim", riskLevel: "low" },
    { name: "Estimate payout", riskLevel: "medium" },
    { name: "Approve / deny claim", riskLevel: "high" },
    { name: "Flag potential duplicate claim", riskLevel: "medium" },
  ];
  for (const t of tasks) {
    const task = await prisma.task.create({ data: { agentId: triage.id, name: t.name, key: TASK_KEYS[t.name], riskLevel: t.riskLevel } });
    await prisma.policy.create({
      data: {
        agentId: triage.id,
        name: `${t.name} — escalation policy`,
        config: { taskName: t.name, escalationThreshold: ESCALATION_THRESHOLDS[t.name] },
      },
    });
    console.log(`  task: ${task.name} (${t.riskLevel})  escalate<${ESCALATION_THRESHOLDS[t.name]}`);
  }

  const support = await prisma.agent.create({
    data: {
      orgId: org.id,
      name: "Customer Support Agent",
      purpose: "Handles tier-1 policyholder support: status lookups, FAQ, and ticket resolution.",
    },
  });
  await prisma.task.create({ data: { agentId: support.id, name: "Resolve support ticket", key: TASK_KEYS["Resolve support ticket"], riskLevel: "low" } });
  await prisma.policy.create({
    data: {
      agentId: support.id,
      name: "Shadow-mode token cap",
      config: { maxTokensPerEvent: 2000, mode: "SHADOW", action: "throttle_and_flag" },
    },
  });
  console.log("  agent: Customer Support Agent — task: Resolve support ticket  (token cap 2000/event)");

  // Verify zero events.
  const eventCount = await prisma.event.count();
  const scoreCount = await prisma.score.count();
  console.log(`\nStructure seed complete. events=${eventCount} scores=${scoreCount} (must be 0/0).`);
  if (eventCount !== 0 || scoreCount !== 0) {
    console.error("Structure seed must have zero events and zero scores.");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(64));
  console.log("  ORG API KEY — shown ONCE, not stored (only its hash + prefix are).");
  console.log("  Paste into the external agent repo's .env as PROVABLE_API_KEY:\n");
  console.log(`      ${fullKey}`);
  console.log(`\n  display prefix (stored): ${apiKeyPrefix}…`);
  console.log("  org: Atlas Insurance   PROVABLE_API_URL=http://localhost:4000");
  console.log("=".repeat(64));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
