-- CreateTable
CREATE TABLE "GatewayCall" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GatewayCall_orgId_createdAt_idx" ON "GatewayCall"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "GatewayCall" ADD CONSTRAINT "GatewayCall_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayCall" ADD CONSTRAINT "GatewayCall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
