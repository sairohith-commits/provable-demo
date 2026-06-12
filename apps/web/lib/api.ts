export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type Mode = "SOLO" | "COPILOT" | "SHADOW";

export interface Score {
  readinessScore: number;
  mode: Mode;
  accuracyRate: number;
  confidenceAvg: number;
  overrideRate: number;
  escalationRate: number;
  eventCount: number;
  calculatedAt: string;
}

export interface TaskSummary {
  id: string;
  name: string;
  key?: string | null;
  riskLevel: string;
  latestScore: Score | null;
}

export interface TaskDetail extends TaskSummary {
  history: Score[];
}

export interface Agent {
  id: string;
  name: string;
  purpose: string;
  createdAt?: string;
  lastEventAt?: string | null;
  tasks: TaskSummary[];
}

// "3m ago", "2h ago", "just now" — for Enrolled / live labels.
export function relativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diffMs / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function isRecent(iso?: string | null, withinMs = 5 * 60 * 1000): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < withinMs;
}

export interface AgentDetail {
  id: string;
  name: string;
  purpose: string;
  tasks: TaskDetail[];
}

export interface Alert {
  id: string;
  agentId: string;
  type: string;
  severity: string;
  message: string;
  resolved: boolean;
  metadata: Record<string, any> | null;
  createdAt: string;
}

export interface Roi {
  claimsProcessed: number;
  resolvedOutcomes: number;
  flaggedDecisions: number;
  costPerResolvedOutcomeUsd: number;
  humanCostPerClaimUsd: number;
  humanBaselineCostUsd: number;
  agentComputeCostUsd: number;
  oversightCostUsd: number;
  agentTotalCostUsd: number;
  netSavingsUsd: number;
  hoursSaved: number;
  roiScore: number;
  assumptions: Record<string, number>;
}

export interface TokenBucket {
  ts: string;
  avgTokens: number;
  totalTokens: number;
  anomaly: boolean;
}

export interface ClaimEvent {
  id: string;
  outcome: "SUCCESS" | "FAILURE" | "PARTIAL";
  confidence: number;
  wasOverridden: boolean;
  wasEscalated: boolean;
  latencyMs: number | null;
  tokens: number | null;
  metadata: Record<string, any> | null;
  createdAt: string;
}

// All api.* fetches run in a SERVER context (the dashboard pages are async RSCs
// with `export const dynamic = "force-dynamic"`; client components only import
// types/helpers from this module). PROVABLE_API_KEY is a server-only env var —
// it is read here, never prefixed NEXT_PUBLIC_, and never reaches the browser.
// The dashboard endpoints are tenant-scoped, so the key identifies the org whose
// agents/alerts/roi/tokens/audit are returned.
async function get<T>(path: string): Promise<T> {
  const key = process.env.PROVABLE_API_KEY;
  const headers: Record<string, string> = key ? { "x-provable-key": key } : {};
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", headers });
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => get<Agent[]>("/agents"),
  agent: (id: string) => get<AgentDetail>(`/agents/${id}`),
  alerts: (id: string) => get<Alert[]>(`/agents/${id}/alerts`),
  roi: (id: string) => get<Roi>(`/agents/${id}/roi`),
  tokens: (id: string) => get<TokenBucket[]>(`/agents/${id}/tokens`),
  audit: (taskId: string) => get<{ task: { id: string; name: string }; events: ClaimEvent[] }>(`/tasks/${taskId}/audit?limit=120`),
};

// ---- mode helpers ----
export function modeLabel(m: Mode): string {
  return m === "SOLO" ? "Solo" : m === "COPILOT" ? "Co-Pilot" : "Shadow";
}
export function modeBadgeVariant(m: Mode): "solo" | "copilot" | "shadow" {
  return m === "SOLO" ? "solo" : m === "COPILOT" ? "copilot" : "shadow";
}
export function modeBlurb(m: Mode): string {
  return m === "SOLO"
    ? "Trusted to act autonomously."
    : m === "COPILOT"
      ? "Drafts decisions; a human approves."
      : "Runs silently for evaluation; humans decide.";
}
