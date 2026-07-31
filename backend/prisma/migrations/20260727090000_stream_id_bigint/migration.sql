-- Convert on-chain stream identifiers from int4 to bigint (Soroban u64).
-- Drop the FK first so both columns can be widened, then recreate it.

ALTER TABLE "StreamEvent" DROP CONSTRAINT IF EXISTS "StreamEvent_streamId_fkey";

ALTER TABLE "Stream" ALTER COLUMN "streamId" TYPE BIGINT USING ("streamId"::bigint);
ALTER TABLE "StreamEvent" ALTER COLUMN "streamId" TYPE BIGINT USING ("streamId"::bigint);

ALTER TABLE "StreamEvent"
  ADD CONSTRAINT "StreamEvent_streamId_fkey"
  FOREIGN KEY ("streamId") REFERENCES "Stream"("streamId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
