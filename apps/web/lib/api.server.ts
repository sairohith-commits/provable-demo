import "server-only";
import { cache } from "react";
import { getActiveOrg } from "./getActiveOrg";
import {
  API_URL,
  type Agent,
  type AgentDetail,
  type Alert,
  type Roi,
  type TokenBucket,
  type ClaimEvent,
} from "./api";

// Server-only dashboard read layer (C3). Replaces the transitional shared
// PROVABLE_API_KEY: every read authenticates to the Provable API with the
// internal service token (server-only env var, never shipped to the browser)
// plus `x-provable-org-id`, where the org id is derived ONLY from the
// Clerk-verified session via getActiveOrg() — never from client input
// (defense-in-depth re: CVE-2025-29927). The API's C1 internal-auth branch then
// scopes the response to that org through the existing tenant-guard.

// Resolve the active Provable org id once per server request (React cache
// memoizes, so a page issuing several reads only resolves/provisions once).
const activeOrgId = cache(async (): Promise<string | null> => {
  const active = await getActiveOrg();
  return active.status === "active" ? active.org.id : null;
});

async function get<T>(path: string): Promise<T> {
  const token = process.env.PROVABLE_INTERNAL_TOKEN;
  if (!token) throw new Error("PROVABLE_INTERNAL_TOKEN is not configured on the dashboard server");

  const orgId = await activeOrgId();
  if (!orgId) throw new Error(`no active organization in session for ${path}`);

  const res = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      "x-provable-org-id": orgId,
    },
  });
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => get<Agent[]>("/agents"),
  agent: (id: string) => get<AgentDetail>(`/agents/${id}`),
  alerts: (id: string) => get<Alert[]>(`/agents/${id}/alerts`),
  roi: (id: string) => get<Roi>(`/agents/${id}/roi`),
  tokens: (id: string) => get<TokenBucket[]>(`/agents/${id}/tokens`),
  audit: (taskId: string) =>
    get<{ task: { id: string; name: string }; events: ClaimEvent[] }>(`/tasks/${taskId}/audit?limit=120`),
};
