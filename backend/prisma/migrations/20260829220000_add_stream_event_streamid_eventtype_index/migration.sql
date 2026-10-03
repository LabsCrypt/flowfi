-- Add composite index for EXISTS-style subqueries that filter StreamEvent
-- by both streamId and eventType (e.g., cancelled/completed status filters).
-- The existing single-column indexes on streamId and eventType cannot efficiently
-- serve a query that needs both columns simultaneously.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StreamEvent_streamId_eventType_idx" ON "StreamEvent"("streamId", "eventType");
