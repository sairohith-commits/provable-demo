import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModeBadge } from "@/components/mode-badge";
import { cn } from "@/lib/utils";
import type { TaskSummary } from "@/lib/api";

function plainEnglish(task: TaskSummary): string {
  const s = task.latestScore;
  if (!s) return "Not enough evidence yet.";
  const outOf10 = (r: number) => Math.round(r * 10);
  if (s.mode === "SHADOW") {
    return `Your team corrected this agent on ${outOf10(s.overrideRate)} of every 10 claims, and it escalated ${outOf10(s.escalationRate)} of 10 to a human. It is not ready to decide on its own — keep it in Shadow.`;
  }
  if (s.mode === "COPILOT") {
    return `It gets the call right about ${Math.round(s.accuracyRate * 100)}% of the time, but your team still adjusts ${outOf10(s.overrideRate)} of every 10. Let it draft, with a human approving — Co-Pilot.`;
  }
  return `Accurate on ${Math.round(s.accuracyRate * 100)}% of claims, with humans overriding fewer than ${Math.max(1, outOf10(s.overrideRate))} in 10. Cleared to run Solo.`;
}

export function WhyMode({ tasks }: { tasks: TaskSummary[] }) {
  const scored = tasks.filter((t) => t.latestScore);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Why these verdicts</CardTitle>
        <p className="text-sm text-muted-foreground">Same agent, four tasks, four different levels of trust — readiness is decided per task, never blanket per agent.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {scored.map((t) => {
          const s = t.latestScore!;
          const emphasize = s.mode === "SHADOW";
          return (
            <div key={t.id} className={cn("rounded-lg border p-4", emphasize && "border-danger/30 bg-danger-soft/40")}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-medium">{t.name}</span>
                <ModeBadge mode={s.mode} />
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{plainEnglish(t)}</p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
