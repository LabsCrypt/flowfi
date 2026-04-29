-- AlterTable
ALTER TABLE "Stream" ADD COLUMN "isPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Stream" ADD COLUMN "pausedAt" INTEGER;
ALTER TABLE "Stream" ADD COLUMN "totalPausedDuration" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Stream_isPaused_idx" ON "Stream"("isPaused");
