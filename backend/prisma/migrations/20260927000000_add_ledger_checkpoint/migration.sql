-- CreateTable
CREATE TABLE "LedgerCheckpoint" (
    "ledgerSequence" INTEGER NOT NULL,
    "ledgerHash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventsCount" INTEGER NOT NULL,
    "stateRootHash" TEXT,
    "isReverted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LedgerCheckpoint_pkey" PRIMARY KEY ("ledgerSequence")
);

-- CreateIndex
CREATE INDEX "LedgerCheckpoint_processedAt_idx" ON "LedgerCheckpoint"("processedAt");
