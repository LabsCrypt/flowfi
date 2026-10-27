-- Remove duplicate StreamEvent rows before adding the unique constraint.
-- Keeps the row with the lowest id for each (transactionHash, eventType) pair.
DELETE FROM "StreamEvent"
WHERE id NOT IN (
  SELECT MIN(id)
  FROM "StreamEvent"
  WHERE "transactionHash" IS NOT NULL
  GROUP BY "transactionHash", "eventType"
)
AND "transactionHash" IS NOT NULL;

-- Drop the plain transactionHash index if it was narrowed to a composite unique index.
DROP INDEX IF EXISTS "StreamEvent_transactionHash_idx";

-- AddUniqueConstraint: composite unique constraint for event deduplication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'StreamEvent_transactionHash_eventType_key'
  ) THEN
    ALTER TABLE "StreamEvent"
      ADD CONSTRAINT "StreamEvent_transactionHash_eventType_key"
      UNIQUE ("transactionHash", "eventType");
  END IF;
END $$;
