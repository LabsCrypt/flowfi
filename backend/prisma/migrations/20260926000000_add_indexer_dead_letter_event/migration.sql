-- Replaces the initial dead-letter table (20260830) with the richer schema
-- that the indexer service and admin dead-letter endpoints require.
-- The old table used a simple unique index on eventId only; the new schema
-- uses a composite unique on (eventId, eventType) and replaces the columns
-- `ledger`/`transactionHash`/`rawPayload` with `ledgerSequence`/`txHash`/
-- `payload`/`eventType`/`cursor`.

-- DropTable (created by 20260830000000_add_indexer_dead_letter_event)
DROP TABLE IF EXISTS "IndexerDeadLetterEvent";

-- CreateTable
CREATE TABLE "IndexerDeadLetterEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "cursor" TEXT,
    "payload" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexerDeadLetterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IndexerDeadLetterEvent_eventId_eventType_key" ON "IndexerDeadLetterEvent"("eventId", "eventType");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_ledgerSequence_idx" ON "IndexerDeadLetterEvent"("ledgerSequence");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_createdAt_idx" ON "IndexerDeadLetterEvent"("createdAt");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_attempts_idx" ON "IndexerDeadLetterEvent"("attempts");

-- CreateIndex
CREATE INDEX "IndexerDeadLetterEvent_eventType_idx" ON "IndexerDeadLetterEvent"("eventType");
