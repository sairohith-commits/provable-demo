"use client";

import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { usd, num } from "@/lib/utils";
import type { TokenBucket, Alert } from "@/lib/api";

function fmtDate(ts: string) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function CostView({ tokens, alert }: { tokens: TokenBucket[]; alert: Alert | null }) {
  const data = tokens.map((t) => ({ date: fmtDate(t.ts), avgTokens: t.avgTokens, anomaly: t.anomaly }));
  const meta = alert?.metadata ?? {};
  const cap = Number(meta.tokenCapPerEvent ?? 2000);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle>Token burn — Customer Support Agent</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Average tokens per decision, hourly. The <span className="font-medium text-danger">red spike</span> is a 6-hour tokenmaxxing loop ~7 days ago — caught and capped.
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" minTickGap={28} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} width={48} />
                <ReferenceLine y={cap} stroke="hsl(var(--accent))" strokeDasharray="5 4" label={{ value: `Shadow cap ${num(cap)}`, position: "insideTopLeft", fontSize: 10, fill: "hsl(var(--accent))" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))", fontSize: 12 }} formatter={(v: number) => [`${num(v)} tokens`, "Avg / decision"]} />
                <Bar dataKey="avgTokens" radius={[2, 2, 0, 0]}>
                  {data.map((d, i) => (
                    <Cell key={i} fill={d.anomaly ? "hsl(var(--danger))" : "hsl(var(--accent))"} fillOpacity={d.anomaly ? 0.95 : 0.55} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="border-danger/30">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Runaway Cost alert</CardTitle>
            <div className="flex gap-1.5">
              <Badge variant="danger">{String(meta.spikeMultiplier ?? 9)}× spike</Badge>
              {alert?.resolved && (
                <Badge variant="solo" className="gap-1">
                  <ShieldCheck className="h-3 w-3" /> Resolved
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex gap-2 rounded-lg bg-danger-soft/50 p-3 text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="leading-snug text-foreground">{alert?.message ?? "No alert."}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Efficiency score" value={`${meta.efficiencyScore ?? "—"}`} />
            <Metric label="Peak tokens/decision" value={num(Number(meta.peakTokensPerEvent ?? 0))} />
            <Metric label="Normal baseline" value={num(Number(meta.normalTokensPerEvent ?? 0))} />
            <Metric label="Saved by cap" value={usd(Number(meta.savedByCapUsd ?? 0))} accent />
          </div>
          <div className="rounded-lg border bg-background p-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">How it stopped:</span> {String(meta.action ?? "Shadow-mode token cap engaged.")}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${accent ? "text-solo" : ""}`}>{value}</div>
    </div>
  );
}
