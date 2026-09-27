-- Upgrade the original dead-letter table to the event quarantine model.
-- Preserve existing records while adapting the column names and shape.
ALTER TABLE "IndexerDeadLetterEvent"
    ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN "txHash" TEXT,
    ADD COLUMN "ledgerSequence" INTEGER,
    ADD COLUMN "cursor" TEXT,
    ADD COLUMN "payload" TEXT;

UPDATE "IndexerDeadLetterEvent"
SET "txHash" = "transactionHash",
    "ledgerSequence" = "ledger",
    "payload" = "rawPayload";

ALTER TABLE "IndexerDeadLetterEvent"
    ALTER COLUMN "eventType" DROP DEFAULT,
    ALTER COLUMN "txHash" SET NOT NULL,
    ALTER COLUMN "ledgerSequence" SET NOT NULL,
    ALTER COLUMN "payload" SET NOT NULL,
    DROP COLUMN "transactionHash",
    DROP COLUMN "ledger",
    DROP COLUMN "rawPayload";

DROP INDEX "IndexerDeadLetterEvent_eventId_key";
CREATE UNIQUE INDEX "IndexerDeadLetterEvent_eventId_eventType_key"
    ON "IndexerDeadLetterEvent"("eventId", "eventType");
CREATE INDEX "IndexerDeadLetterEvent_ledgerSequence_idx"
    ON "IndexerDeadLetterEvent"("ledgerSequence");
CREATE INDEX "IndexerDeadLetterEvent_attempts_idx"
    ON "IndexerDeadLetterEvent"("attempts");
CREATE INDEX "IndexerDeadLetterEvent_eventType_idx"
    ON "IndexerDeadLetterEvent"("eventType");
