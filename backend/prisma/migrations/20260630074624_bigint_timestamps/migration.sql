-- AlterTable
ALTER TABLE "Stream" ADD COLUMN     "endTime" BIGINT,
ALTER COLUMN "startTime" SET DATA TYPE BIGINT,
ALTER COLUMN "lastUpdateTime" SET DATA TYPE BIGINT,
ALTER COLUMN "pausedAt" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "StreamEvent" ALTER COLUMN "timestamp" SET DATA TYPE BIGINT;

-- CreateIndex
CREATE INDEX "StreamEvent_createdAt_idx" ON "StreamEvent"("createdAt");

-- CreateIndex
CREATE INDEX "StreamEvent_streamId_createdAt_idx" ON "StreamEvent"("streamId", "createdAt");
