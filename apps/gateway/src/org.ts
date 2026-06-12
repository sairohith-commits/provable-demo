import { prisma, hashApiKey } from "@provable/db";

// Same org resolution as apps/api requireOrg — resolves by sha256 hash of the
// presented key against the unique apiKeyHash index. hashApiKey comes from
// @provable/db so the gateway has no runtime dependency on apps/api.
// Org resolution only — provider/Anthropic key forwarding & logging are untouched.
export async function orgFromKey(req: { headers: Record<string, any> }) {
  const presented = req.headers["x-provable-key"];
  if (typeof presented !== "string" || !presented.startsWith("pk_live_")) return null;
  return prisma.org.findUnique({ where: { apiKeyHash: hashApiKey(presented) } });
}

// Find-or-create the agent for this org, mirroring the agent-creation half of
// POST /register. Used to auto-register agents discovered via the gateway.
export async function ensureAgent(orgId: string, name: string) {
  let agent = await prisma.agent.findFirst({ where: { orgId, name } });
  if (!agent) {
    agent = await prisma.agent.create({ data: { orgId, name, purpose: "" } });
  }
  return agent;
}
