import { Badge } from "@/components/ui/badge";
import { modeBadgeVariant, modeLabel, type Mode } from "@/lib/api";

export function ModeBadge({ mode, className }: { mode: Mode; className?: string }) {
  return (
    <Badge variant={modeBadgeVariant(mode)} className={className}>
      {modeLabel(mode)}
    </Badge>
  );
}
