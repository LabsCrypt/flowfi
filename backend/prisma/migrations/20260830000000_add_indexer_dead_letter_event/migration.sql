-- Dead-letter table for Soroban events that failed to process. A single
-- malformed event must not freeze the indexer: after N failed attempts the
-- worker abandons the event (recording it here with its raw payload for
-- manual triage) and advances the cursor past it.

-- CreateTable
CREATE TABLE "IndexerDeadLetterEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "rawPayload" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexerDeadLetterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IndexerDeadLetterEvent_eventId_key" ON "IndexerDeadLetterEvent"("eventId");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_ledger_idx" ON "IndexerDeadLetterEvent"("ledger");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_transactionHash_idx" ON "IndexerDeadLetterEvent"("transactionHash");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_createdAt_idx" ON "IndexerDeadLetterEvent"("createdAt");
