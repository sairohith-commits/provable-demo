import { api } from "@/lib/api";
import { RegistryCard } from "@/components/registry-card";
import { OnboardAgentModal } from "@/components/onboard-agent-modal";

export const dynamic = "force-dynamic";

export default async function RegistryPage() {
  const agents = await api.agents();

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

      <div className="grid gap-6 md:grid-cols-2">
        {agents.map((a) => (
          <RegistryCard key={a.id} agent={a} />
        ))}
      </div>
    </div>
  );
}
