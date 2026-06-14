-- AlterTable: additive, nullable link to a Clerk Organization (backfilled in C6).
ALTER TABLE "Org" ADD COLUMN "clerkOrgId" TEXT;

-- CreateIndex: unique. Postgres allows multiple NULLs, so existing/unlinked rows
-- (Atlas, Beta) remain valid until their clerkOrgId is backfilled.
CREATE UNIQUE INDEX "Org_clerkOrgId_key" ON "Org"("clerkOrgId");
