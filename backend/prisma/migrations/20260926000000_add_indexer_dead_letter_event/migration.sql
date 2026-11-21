-- The dead-letter table was first created by
-- 20260830000000_add_indexer_dead_letter_event with a narrower shape
-- (transactionHash/ledger/rawPayload). This migration used to DROP it with
-- CASCADE and recreate it, which destroyed every quarantined event on any
-- replay. Evolve the existing table in place instead: rename the columns that
-- moved, add the ones that are new, and swap the indexes for the ones the model
-- declares.

-- RenameColumn
ALTER TABLE "IndexerDeadLetterEvent" RENAME COLUMN "transactionHash" TO "txHash";
ALTER TABLE "IndexerDeadLetterEvent" RENAME COLUMN "ledger" TO "ledgerSequence";
ALTER TABLE "IndexerDeadLetterEvent" RENAME COLUMN "rawPayload" TO "payload";

-- AddColumn (existing rows predate event types, so they get an empty one)
ALTER TABLE "IndexerDeadLetterEvent" ADD COLUMN "eventType" TEXT NOT NULL DEFAULT '';
ALTER TABLE "IndexerDeadLetterEvent" ALTER COLUMN "eventType" DROP DEFAULT;
ALTER TABLE "IndexerDeadLetterEvent" ADD COLUMN "cursor" TEXT;

-- DropIndex (superseded by the eventId+eventType uniqueness below)
DROP INDEX "IndexerDeadLetterEvent_eventId_key";
DROP INDEX "IndexerDeadLetterEvent_ledger_idx";
DROP INDEX "IndexerDeadLetterEvent_transactionHash_idx";
DROP INDEX "IndexerDeadLetterEvent_createdAt_idx";

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
