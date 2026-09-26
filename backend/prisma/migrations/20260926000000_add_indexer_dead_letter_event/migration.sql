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
