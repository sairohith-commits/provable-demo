"use client";

import { useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModeBadge } from "@/components/mode-badge";
import { num } from "@/lib/utils";
import type { TaskDetail } from "@/lib/api";

function fmtDate(ts: string) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function TrendChart({ tasks, defaultTaskName }: { tasks: TaskDetail[]; defaultTaskName?: string }) {
  const withHistory = tasks.filter((t) => t.history.length > 0);
  const initial = withHistory.find((t) => t.name === defaultTaskName)?.id ?? withHistory[0]?.id;
  const [selected, setSelected] = useState<string>(initial);
  const task = withHistory.find((t) => t.id === selected) ?? withHistory[0];

  const data = task.history.map((h) => ({ date: fmtDate(h.calculatedAt), score: Math.round(h.readinessScore) }));
  const latest = task.latestScore;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>30-day readiness trend</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {task.name} · based on {latest ? num(latest.eventCount) : 0} decisions
            </p>
          </div>
          {latest && <ModeBadge mode={latest.mode} />}
        </div>
        <Tabs value={selected} onValueChange={setSelected} className="mt-3">
          <TabsList>
            {withHistory.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
              {/* mode bands */}
              <ReferenceArea y1={71} y2={100} fill="hsl(var(--solo))" fillOpacity={0.05} />
              <ReferenceArea y1={41} y2={70} fill="hsl(var(--copilot))" fillOpacity={0.05} />
              <ReferenceArea y1={0} y2={40} fill="hsl(var(--shadow))" fillOpacity={0.05} />
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} width={32} />
              <ReferenceLine y={70} stroke="hsl(var(--solo))" strokeDasharray="4 4" label={{ value: "Solo ≥ 71", position: "insideTopRight", fontSize: 10, fill: "hsl(var(--solo))" }} />
              <ReferenceLine y={40} stroke="hsl(var(--shadow))" strokeDasharray="4 4" label={{ value: "Shadow ≤ 40", position: "insideBottomRight", fontSize: 10, fill: "hsl(var(--shadow))" }} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))", fontSize: 12 }}
                formatter={(v: number) => [`${v} / 100`, "Readiness"]}
              />
              <Line type="monotone" dataKey="score" stroke="hsl(var(--accent))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
