import { Provable } from "@provable/sdk";
import { API_URL } from "./env.js";

export interface Targets {
  triageId: string;
  supportId: string | null;
  supportTaskId: string | null;
  tasks: Record<string, { agentId: string; taskId: string }>;
}

interface AgentDto {
  id: string;
  name: string;
  tasks: Array<{ id: string; name: string; latestScore: { readinessScore: number; mode: string; eventCount: number } | null }>;
}

export const provable = new Provable({ apiUrl: API_URL, apiKey: "demo" });

export async function fetchAgents(): Promise<AgentDto[]> {
  const res = await fetch(`${API_URL}/agents`);
  if (!res.ok) throw new Error(`GET /agents failed: ${res.status}`);
  return (await res.json()) as AgentDto[];
}

// Resolve agent/task IDs by NAME at runtime — no hardcoded IDs.
export async function resolveTargets(): Promise<Targets> {
  const agents = await fetchAgents();
  const triage = agents.find((a) => a.name === "Claims Triage Agent");
  const support = agents.find((a) => a.name === "Customer Support Agent");
  if (!triage) throw new Error("Claims Triage Agent not found — run `pnpm db:seed:structure` first.");

  const byName = (name: string) => {
    const t = triage.tasks.find((x) => x.name === name);
    if (!t) throw new Error(`Task "${name}" not found on Claims Triage Agent.`);
    return { agentId: triage.id, taskId: t.id };
  };

  return {
    triageId: triage.id,
    supportId: support?.id ?? null,
    supportTaskId: support?.tasks[0]?.id ?? null,
    tasks: {
      categorize: byName("Categorize claim"),
      estimate: byName("Estimate payout"),
      approve: byName("Approve / deny claim"),
      duplicate: byName("Flag potential duplicate claim"),
    },
  };
}

export async function taskScores(agentId: string) {
  const agents = await fetchAgents();
  const agent = agents.find((a) => a.id === agentId);
  return (agent?.tasks ?? []).map((t) => ({
    name: t.name,
    score: t.latestScore?.readinessScore ?? null,
    mode: t.latestScore?.mode ?? null,
    eventCount: t.latestScore?.eventCount ?? 0,
  }));
}
