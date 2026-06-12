-- Required for sha256 backfill of existing apiKey values
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- AlterTable: add new columns as nullable first so existing rows can be backfilled
ALTER TABLE "Org" ADD COLUMN "apiKeyHash" TEXT;
ALTER TABLE "Org" ADD COLUMN "apiKeyPrefix" TEXT;
ALTER TABLE "Org" ADD COLUMN "apiKeyRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill from the existing plaintext apiKey (transitional; real keys are issued in Phase S4)
UPDATE "Org"
SET "apiKeyHash" = encode(digest("apiKey", 'sha256'), 'hex'),
    "apiKeyPrefix" = left("apiKey", 16)
WHERE "apiKey" IS NOT NULL;

-- Any org without a legacy apiKey gets a unique placeholder so NOT NULL/UNIQUE can be enforced
UPDATE "Org"
SET "apiKeyHash" = encode(digest('placeholder:' || "id", 'sha256'), 'hex'),
    "apiKeyPrefix" = 'pk_live_unset'
WHERE "apiKeyHash" IS NULL;

-- Enforce NOT NULL now that all rows are populated
ALTER TABLE "Org" ALTER COLUMN "apiKeyHash" SET NOT NULL;
ALTER TABLE "Org" ALTER COLUMN "apiKeyPrefix" SET NOT NULL;

-- DropIndex
DROP INDEX IF EXISTS "Org_apiKey_key";

-- AlterTable
ALTER TABLE "Org" DROP COLUMN "apiKey";

-- CreateIndex
CREATE UNIQUE INDEX "Org_apiKeyHash_key" ON "Org"("apiKeyHash");
