import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ModeBadge } from "@/components/mode-badge";
import { cn, num } from "@/lib/utils";
import type { TaskSummary, Mode } from "@/lib/api";

const NEW_TASK_THRESHOLD = 30; // a freshly deployed task still gathering evidence

function MetricBar({ label, value, goodWhenLow = false }: { label: string; value: number; goodWhenLow?: boolean }) {
  const pct = Math.round(value * 100);
  // "Good" reads green, "bad" reads amber/grey — restrained, not a rainbow.
  const good = goodWhenLow ? value <= 0.15 : value >= 0.8;
  const mid = goodWhenLow ? value <= 0.35 : value >= 0.55;
  const barColor = good ? "bg-solo" : mid ? "bg-copilot" : "bg-shadow";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const scoreColor: Record<Mode, string> = {
  SOLO: "text-solo",
  COPILOT: "text-copilot",
  SHADOW: "text-shadow",
};

export function ReadinessCard({ task, highlight = false }: { task: TaskSummary; highlight?: boolean }) {
  const s = task.latestScore;
  const isNew = !!s && s.eventCount <= NEW_TASK_THRESHOLD;
  return (
    <Card className={cn("flex flex-col", (highlight || isNew) && "ring-2 ring-accent")}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold leading-tight">{task.name}</span>
              {isNew && <Badge className="bg-accent text-accent-foreground">NEW</Badge>}
            </div>
            <div className="mt-0.5 text-xs uppercase tracking-wide text-muted-foreground">{task.riskLevel} risk</div>
          </div>
          {s && <ModeBadge mode={s.mode} />}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {s ? (
          <>
            <div className="flex items-end gap-2">
              <span className={cn("text-5xl font-bold tabular-nums leading-none", scoreColor[s.mode])}>{Math.round(s.readinessScore)}</span>
              <span className="pb-1 text-sm text-muted-foreground">/ 100 readiness</span>
            </div>
            <div className="space-y-2.5">
              <MetricBar label="Accuracy" value={s.accuracyRate} />
              <MetricBar label="Confidence" value={s.confidenceAvg} />
              <MetricBar label="Override rate" value={s.overrideRate} goodWhenLow />
              <MetricBar label="Escalation rate" value={s.escalationRate} goodWhenLow />
            </div>
            <div className="mt-auto border-t pt-3 text-xs text-muted-foreground">
              {isNew ? (
                <span className="font-medium text-accent">NEW · {num(s.eventCount)} decisions · just coming online</span>
              ) : (
                <>
                  Based on <span className="font-semibold text-foreground tabular-nums">{num(s.eventCount)}</span> decisions (30-day window)
                </>
              )}
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">No score yet.</div>
        )}
      </CardContent>
    </Card>
  );
}
