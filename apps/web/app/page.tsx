import { redirect } from "next/navigation";
import { api, type Agent } from "@/lib/api";
import { getActiveOrg } from "@/lib/getActiveOrg";
import { RegistryCard } from "@/components/registry-card";
import { OnboardAgentModal } from "@/components/onboard-agent-modal";

export const dynamic = "force-dynamic";

export default async function RegistryPage() {
  // C2: server-derived org context (orgId comes only from the verified Clerk
  // session). A signed-in user with an active org gets their Provable Org
  // JIT-provisioned here; a signed-in user with no org is routed to onboarding.
  // Signed-out visitors fall through to the transitional public dashboard below
  // (data still flows via PROVABLE_API_KEY until the C3 swap).
  const active = await getActiveOrg();
  if (active.status === "needs-onboarding") redirect("/onboarding");

  // The authed landing must NOT be coupled to the transitional PROVABLE_API_KEY
  // (C3 replaces this with per-org reads). If that key is missing/invalid the
  // /agents read 401s — degrade to an empty registry instead of hard-500ing.
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
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          {loadError
            ? "Couldn’t load agents right now. Per-organization dashboard data is wired up in the next step."
            : "No agents yet — install the SDK and send your first event to see them here."}
        </div>
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
