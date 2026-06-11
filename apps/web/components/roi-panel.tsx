import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usd, num } from "@/lib/utils";
import type { Roi } from "@/lib/api";

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-2 text-3xl font-bold tabular-nums ${accent ? "text-solo" : "text-foreground"}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function RoiPanel({ roi }: { roi: Roi }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>ROI Proof Engine</CardTitle>
        <p className="text-sm text-muted-foreground">
          {num(roi.claimsProcessed)} claims processed · human baseline {usd(roi.humanCostPerClaimUsd)}/claim
          ({roi.assumptions.humanMinutesPerClaim} min @ {usd(roi.assumptions.humanLoadedHourlyUsd)}/hr).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Cost per resolved claim" value={usd(roi.costPerResolvedOutcomeUsd)} sub={`vs ${usd(roi.humanCostPerClaimUsd)} human`} accent />
          <Stat label="Hours reclaimed" value={num(roi.hoursSaved)} sub="adjuster hours, 30 days" />
          <Stat label="Net savings" value={usd(roi.netSavingsUsd)} sub={`after ${usd(roi.oversightCostUsd)} human review`} />
          <Stat label="ROI score" value={`${roi.roiScore}`} sub="% of baseline reclaimed" accent />
        </div>
        <p className="text-xs text-muted-foreground">
          Earned, not maxed: ROI is net of {usd(roi.agentComputeCostUsd)} agent compute <span className="px-0.5">+</span>
          {usd(roi.oversightCostUsd)} human review on {num(roi.flaggedDecisions)} flagged decisions, against a {usd(roi.humanBaselineCostUsd)} all-human baseline.
        </p>
      </CardContent>
    </Card>
  );
}
