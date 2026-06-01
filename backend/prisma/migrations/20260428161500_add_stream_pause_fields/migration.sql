-- The pause-state columns (isPaused, pausedAt, totalPausedDuration) are added by
-- the earlier migration `20260428000000_add_pause_state_fields`, which is the
-- single source of truth for them. This migration only adds the index, so that a
-- fresh `prisma migrate deploy` no longer fails with
-- `column "isPaused" of relation "Stream" already exists`.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Stream_isPaused_idx" ON "Stream"("isPaused");
