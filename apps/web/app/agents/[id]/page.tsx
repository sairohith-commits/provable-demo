import Link from "next/link";
import { api } from "@/lib/api";
import { ReadinessCard } from "@/components/readiness-card";
import { TrendChart } from "@/components/trend-chart";
import { WhyMode } from "@/components/why-mode";
import { RoiPanel } from "@/components/roi-panel";
import { CostView } from "@/components/cost-view";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ScrollText } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [agent, alerts, roi, tokens] = await Promise.all([api.agent(id), api.alerts(id), api.roi(id), api.tokens(id)]);

  const isClaimsAgent = agent.tasks.length > 1;
  const costAlert = alerts.find((a) => a.type === "RUNAWAY_COST") ?? null;
  const approveTask = agent.tasks.find((t) => t.name.toLowerCase().includes("approve"));

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All agents
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <p className="mt-1 max-w-2xl text-muted-foreground">{agent.purpose}</p>
          </div>
          {approveTask && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/tasks/${approveTask.id}/audit`}>
                <ScrollText className="h-4 w-4" /> Open audit log
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Readiness cards — same agent, different verdicts */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Task readiness</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {agent.tasks.map((t) => (
            <ReadinessCard key={t.id} task={t} />
          ))}
        </div>
      </section>

      {isClaimsAgent && (
        <section className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <TrendChart tasks={agent.tasks} defaultTaskName="Categorize claim" />
          </div>
          <div className="lg:col-span-2">
            <WhyMode tasks={agent.tasks} />
          </div>
        </section>
      )}

      {costAlert && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Cost governance</h2>
          <CostView tokens={tokens} alert={costAlert} />
        </section>
      )}

      <section>
        <RoiPanel roi={roi} />
      </section>
    </div>
  );
}
