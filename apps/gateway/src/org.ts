import { prisma } from "@provable/db";

// Same lookup as apps/api/src/routes.ts orgFromKey — duplicated here so the
// gateway has no runtime dependency on apps/api.
export async function orgFromKey(req: { headers: Record<string, any> }) {
  const key = req.headers["x-provable-key"];
  if (!key) return null;
  return prisma.org.findUnique({ where: { apiKey: String(key) } });
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
