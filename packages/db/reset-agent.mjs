import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const NAME = "Support Triage Agent";
const agent = await p.agent.findFirst({ where: { name: NAME } });
if (!agent) {
  console.log(`"${NAME}" not present — nothing to reset.`);
} else {
  const tasks = await p.task.findMany({ where: { agentId: agent.id }, select: { id: true } });
  const taskIds = tasks.map((t) => t.id);
  await p.score.deleteMany({ where: { taskId: { in: taskIds } } });
  await p.event.deleteMany({ where: { agentId: agent.id } });
  await p.alert.deleteMany({ where: { agentId: agent.id } });
  await p.task.deleteMany({ where: { agentId: agent.id } });
  await p.agent.delete({ where: { id: agent.id } });
  console.log(`Reset "${NAME}": removed agent, ${taskIds.length} tasks, and all its events/scores/alerts.`);
}
await p.$disconnect();
