import { PrismaClient } from "@prisma/client";
import { tenantGuard } from "./tenantGuard.js";

// Reuse a single PrismaClient across hot-reloads in dev.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaScoped?: ReturnType<typeof buildScoped>;
};

// Base client. Trusted, server-internal callers (recompute, the worker, the
// seed) use this directly — they operate on already-resolved ids.
export const prisma = globalForPrisma.prisma ?? new PrismaClient();

function buildScoped() {
  return prisma.$extends(tenantGuard);
}

// Tenant-guarded client. Request-handling code (the API) queries Agent/Task/Event
// through this so a forgotten orgId filter throws instead of leaking rows.
export const prismaScoped = globalForPrisma.prismaScoped ?? buildScoped();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaScoped = prismaScoped;
}
