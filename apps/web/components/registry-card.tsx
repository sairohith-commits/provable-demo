import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ModeBadge } from "@/components/mode-badge";
import { ArrowRight, Bot } from "lucide-react";
import { modeBadgeVariant, relativeTime, isRecent, type Agent } from "@/lib/api";

const NEW_TASK_THRESHOLD = 30;

export function RegistryCard({ agent }: { agent: Agent }) {
  const scored = agent.tasks.filter((t) => t.latestScore);
  const pending = agent.tasks.filter((t) => !t.latestScore);
  const established = scored.filter((t) => t.latestScore!.eventCount > NEW_TASK_THRESHOLD);
  const newTasks = scored.filter((t) => t.latestScore!.eventCount <= NEW_TASK_THRESHOLD);
  const establishedVerdicts = new Set(established.map((t) => t.latestScore!.mode)).size;
  const live = isRecent(agent.lastEventAt);
  return (
    <Link href={`/agents/${agent.id}`} className="group block">
      <Card className="h-full transition-shadow group-hover:shadow-md">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                <Bot className="h-5 w-5 text-muted-foreground" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">{agent.name}</CardTitle>
                  {live && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-solo">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-solo opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-solo" />
                      </span>
                      live
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {agent.tasks.length} task{agent.tasks.length === 1 ? "" : "s"} governed
                  {agent.createdAt && <> · Enrolled {relativeTime(agent.createdAt)}</>}
                </p>
              </div>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{agent.purpose}</p>
          <div className="flex flex-wrap items-center gap-2">
            {scored.map((t) => {
              const s = t.latestScore!;
              const isNew = s.eventCount <= NEW_TASK_THRESHOLD;
              return (
                <span key={t.id} className="inline-flex items-center gap-1">
                  <Badge variant={modeBadgeVariant(s.mode)} className="gap-1.5">
                    {t.name}
                    <span className="rounded bg-card/60 px-1 tabular-nums">{Math.round(s.readinessScore)}</span>
                  </Badge>
                  {isNew && <Badge className="bg-accent text-accent-foreground">NEW · {s.eventCount} decisions</Badge>}
                </span>
              );
            })}
            {pending.map((t) => (
              <Badge key={t.id} variant="outline" className="gap-1.5 border-dashed text-muted-foreground">
                {t.name}
                <span className="rounded bg-muted px-1 text-[10px] uppercase tracking-wide">pending</span>
              </Badge>
            ))}
          </div>
          {scored.length === 0 && pending.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Just enrolled — scores populate as the agent reports its first decisions.
            </p>
          )}
          {established.length > 1 && newTasks.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {established.length} established tasks, {establishedVerdicts} verdicts — plus {newTasks.length} just coming online. Readiness is task-level.
            </p>
          )}
          {established.length > 1 && newTasks.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Same agent, {establishedVerdicts} different verdicts — readiness is task-level.
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
