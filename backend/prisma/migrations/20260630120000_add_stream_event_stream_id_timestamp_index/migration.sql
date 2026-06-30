-- Replace the unused (streamId, createdAt) composite with (streamId, timestamp),
-- which matches streamId-scoped event listings that ORDER BY timestamp.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StreamEvent_streamId_timestamp_idx" ON "StreamEvent"("streamId", "timestamp");

-- DropIndex
DROP INDEX IF EXISTS "StreamEvent_streamId_createdAt_idx";
