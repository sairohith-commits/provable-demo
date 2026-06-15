import Link from "next/link";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";

type Action = { href: string; label: string };

// Shared empty state for fresh orgs (no agents/events yet). Disappears as soon as
// real data exists because callers only render it when their data is empty.
export function EmptyState({
  title,
  body,
  primary,
  secondary,
  testId,
}: {
  title: string;
  body: string;
  primary?: Action;
  secondary?: Action;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
        <Inbox className="h-6 w-6 text-muted-foreground" />
      </span>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {(primary || secondary) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {primary && (
            <Button asChild size="sm">
              <Link href={primary.href}>{primary.label}</Link>
            </Button>
          )}
          {secondary && (
            <Button asChild size="sm" variant="outline">
              <Link href={secondary.href}>{secondary.label}</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
