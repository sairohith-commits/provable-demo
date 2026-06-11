"use client";

import { Fragment, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, FileText, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ClaimEvent } from "@/lib/api";

function fmtTime(ts: string) {
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function AuditTable({ events, taskName }: { events: ClaimEvent[]; taskName: string }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log — {taskName}</CardTitle>
        <p className="text-sm text-muted-foreground">
          Every decision is recorded. Click a <span className="font-medium text-foreground">denied claim</span> to open its full, immutable decision trail — your answer to a regulator.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Time</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Human action</TableHead>
              <TableHead>Trail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((e) => {
              const m = e.metadata ?? {};
              const isDenial = m.decision === "DENY";
              const expandable = !!m.decision;
              const isOpen = open === e.id;
              return (
                <Fragment key={e.id}>
                  <TableRow
                    className={cn(expandable && "cursor-pointer", isDenial && "bg-danger-soft/30")}
                    onClick={() => expandable && setOpen(isOpen ? null : e.id)}
                  >
                    <TableCell className="text-muted-foreground">
                      {expandable ? isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" /> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums">{fmtTime(e.createdAt)}</TableCell>
                    <TableCell>
                      {m.decision ? (
                        <Badge variant={isDenial ? "danger" : "secondary"}>{m.decision === "DENY" ? "Denied" : String(m.decision)}</Badge>
                      ) : (
                        <Badge variant="secondary">{e.outcome}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">{Math.round(e.confidence * 100)}%</TableCell>
                    <TableCell className="text-sm">
                      {e.wasOverridden ? (
                        <span className="inline-flex items-center gap-1 text-danger">
                          <UserCheck className="h-3.5 w-3.5" /> Overridden
                        </span>
                      ) : e.wasEscalated ? (
                        <span className="text-copilot">Escalated</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {expandable ? (
                        <span className="inline-flex items-center gap-1 text-sm text-accent">
                          <FileText className="h-3.5 w-3.5" /> View
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen && expandable && (
                    <TableRow className="bg-secondary/40 hover:bg-secondary/40">
                      <TableCell />
                      <TableCell colSpan={5} className="py-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <TrailField label="Input summary" value={String(m.inputSummary ?? "—")} />
                          <TrailField label="Agent confidence" value={`${Math.round((m.confidence ?? e.confidence) * 100)}%`} />
                          <TrailField label="Agent reasoning" value={String(m.reasoning ?? "—")} wide />
                          <TrailField
                            label="Human override"
                            wide
                            value={
                              m.humanOverride
                                ? `${m.humanOverride.by} → ${m.humanOverride.overrodeTo}. "${m.humanOverride.note}"`
                                : "None — automated denial upheld."
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TrailField({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn("rounded-lg border bg-card p-3", wide && "md:col-span-2")}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm leading-relaxed">{value}</div>
    </div>
  );
}
