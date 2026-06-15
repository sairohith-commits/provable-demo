import { redirect } from "next/navigation";
import { type Agent } from "@/lib/api";
import { api } from "@/lib/api.server";
import { getActiveOrg } from "@/lib/getActiveOrg";
import { RegistryCard } from "@/components/registry-card";
import { EmptyState } from "@/components/empty-state";
import { OnboardAgentModal } from "@/components/onboard-agent-modal";

export const dynamic = "force-dynamic";

export default async function RegistryPage() {
  // Server-derived org context (orgId comes only from the verified Clerk
  // session). Anyone not yet fully onboarded — no active Clerk org, or an active
  // org whose Provable Org hasn't been provisioned (and key issued) yet — is sent
  // to the onboarding flow, which is the sole provisioner (C4 show-once).
  const active = await getActiveOrg();
  if (active.status === "needs-onboarding" || active.status === "unprovisioned") {
    redirect("/onboarding");
  }

  // C3: reads are scoped to the session's org via the internal token (see
  // lib/api.server.ts). Still degrade to an empty registry on any read failure
  // (no active org / API unavailable) instead of hard-500ing the landing.
  let agents: Agent[] = [];
  let loadError = false;
  try {
    agents = await api.agents();
  } catch {
    loadError = true;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Registry</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            You deployed AI agents into claims operations. Here is the governance layer on top — every agent, every
            task, scored for how much autonomy it has earned.
          </p>
        </div>
        <OnboardAgentModal />
      </div>

      {agents.length === 0 ? (
        <EmptyState
          testId="empty-agents"
          title={loadError ? "Couldn’t load agents" : "No agents yet"}
          body={
            loadError
              ? "We couldn’t reach your agents right now. Try again in a moment."
              : "Install the @provable/sdk and send your first event — your agents and their readiness scores will show up here automatically."
          }
          primary={loadError ? undefined : { href: "/settings", label: "Get your API key" }}
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {agents.map((a) => (
            <RegistryCard key={a.id} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}
