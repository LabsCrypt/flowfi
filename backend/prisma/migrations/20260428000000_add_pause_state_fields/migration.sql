-- AlterTable
ALTER TABLE "Stream" ADD COLUMN     "isPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pausedAt" INTEGER,
ADD COLUMN     "totalPausedDuration" INTEGER NOT NULL DEFAULT 0;
