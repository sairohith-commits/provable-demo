import { Prisma } from "@prisma/client";

// Tenant-scope guard (applied via prisma.$extends in client.ts).
//
// Catches the next forgotten tenant filter at runtime instead of in a breach:
// any read/aggregate/bulk-write against a tenant-scoped model that is NOT scoped
// to its tenant throws `tenant scope missing on ${model}.${operation}`.
//
// Scope field per model: Agent and GatewayCall carry `orgId` directly. Task and
// Event have NO orgId column in the schema — their tenant scope is their parent
// foreign key (Task -> agentId, Event -> agentId|taskId). Requiring orgId on
// Task/Event is structurally impossible (Prisma would reject the unknown field),
// so the guard requires the parent FK there. Because agentIds/taskIds are only
// ever resolved within `req.org.id` (the discipline layer), FK-scoping is
// transitively org-scoping. A bare `where: {}` (or a missing where) throws for
// every guarded model.
const SCOPE_FIELDS: Record<string, string[]> = {
  Agent: ["orgId"],
  Task: ["agentId"],
  Event: ["agentId", "taskId"],
  GatewayCall: ["orgId"],
};

// findUnique/findFirst by primary id are allowed (single-row lookups the caller
// still checks for ownership). These bulk/aggregate ops can leak whole tables,
// so they must be scoped.
const GUARDED_OPS = new Set(["findMany", "updateMany", "deleteMany", "count", "aggregate"]);

function hasScope(where: unknown, fields: string[]): boolean {
  if (!where || typeof where !== "object") return false;
  const w = where as Record<string, unknown>;
  if (fields.some((f) => w[f] !== undefined)) return true;
  // Accept the scope nested inside a top-level AND array (a common Prisma shape).
  if (Array.isArray(w.AND)) return (w.AND as unknown[]).some((clause) => hasScope(clause, fields));
  return false;
}

export const tenantGuard = Prisma.defineExtension({
  name: "tenantGuard",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const fields = model ? SCOPE_FIELDS[model] : undefined;
        if (fields && GUARDED_OPS.has(operation)) {
          const where = (args as { where?: unknown } | undefined)?.where;
          if (!hasScope(where, fields)) {
            throw new Error(`tenant scope missing on ${model}.${operation}`);
          }
        }
        return query(args);
      },
    },
  },
});
