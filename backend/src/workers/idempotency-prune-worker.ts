/**
 * Idempotency key retention worker (Issue #1495)
 *
 * Idempotency keys are only consulted while a retry of the original request is
 * still possible, so rows older than the retention window are dead weight: they
 * keep growing the table (and its indexes) without ever being read again. This
 * worker deletes them on a fixed interval, mirroring the stream runway worker's
 * structure — an immediate first run plus a repeating timer.
 */
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";

/** Keys older than seven days can no longer be replayed and are pruned. */
export const IDEMPOTENCY_KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the retention sweep runs. */
export const IDEMPOTENCY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The oldest `createdAt` still inside the retention window. Rows created before
 * this instant are expired.
 */
export function idempotencyRetentionCutoff(nowMs: number = Date.now()): Date {
  return new Date(nowMs - IDEMPOTENCY_KEY_RETENTION_MS);
}

/** True when a key created at `createdAt` has fallen out of the retention window. */
export function isExpiredIdempotencyKey(
  createdAt: Date,
  nowMs: number = Date.now(),
): boolean {
  return createdAt.getTime() < idempotencyRetentionCutoff(nowMs).getTime();
}

/**
 * Delete every idempotency key older than the retention window and return the
 * number of pruned rows so callers (and tests) can act on the result.
 *
 * Errors propagate: a failed sweep must not be reported as "0 pruned".
 */
export async function pruneExpiredIdempotencyKeys(
  nowMs: number = Date.now(),
): Promise<number> {
  const cutoff = idempotencyRetentionCutoff(nowMs);

  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  logger.info(
    `[IdempotencyPruneWorker] Pruned ${count} expired idempotency key(s) older than ${cutoff.toISOString()}`,
  );

  return count;
}

/**
 * Start the retention worker: prune once immediately, then on every interval.
 * Returns the timer so `stopWorkers` can clear it on shutdown.
 */
export function startIdempotencyPruneWorker(
  intervalMs: number = IDEMPOTENCY_PRUNE_INTERVAL_MS,
): NodeJS.Timeout {
  const run = (phase: "Initial" | "Scheduled") => {
    pruneExpiredIdempotencyKeys().catch((error) => {
      logger.error(`[IdempotencyPruneWorker] ${phase} run failed:`, error);
    });
  };

  run("Initial");

  const timer = setInterval(() => run("Scheduled"), intervalMs);

  logger.info(
    `[IdempotencyPruneWorker] Worker started - pruning keys older than ${IDEMPOTENCY_KEY_RETENTION_MS}ms every ${intervalMs}ms`,
  );

  return timer;
}
