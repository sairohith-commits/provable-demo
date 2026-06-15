import Link from "next/link";
import { api } from "@/lib/api.server";
import { AuditTable } from "@/components/audit-table";
import { EmptyState } from "@/components/empty-state";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { task, events } = await api.audit(id);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Decision audit trail</h1>
        <p className="mt-1 text-muted-foreground">{events.length} most recent decisions for “{task.name}”.</p>
      </div>
      {events.length === 0 ? (
        <EmptyState
          testId="empty-audit"
          title="No decisions yet"
          body="Once your agent reports decisions for this task with the @provable/sdk, the full audit trail shows up here."
          primary={{ href: "/settings", label: "Get your API key" }}
        />
      ) : (
        <AuditTable events={events} taskName={task.name} />
      )}
    </div>
  );
}
