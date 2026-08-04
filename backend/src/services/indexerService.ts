/**
 * Indexer control-plane helpers (status / reset / replay).
 *
 * NOTE ON NAMING: Despite the `indexerService` name, this file is NOT an
 * indexer. It is the admin/control-plane helper for the source-of-truth
 * indexer, `SorobanEventWorker` (backend/src/workers/soroban-event-worker.ts).
 * The functions here only read/reset the shared `IndexerState` cursor row and
 * trigger the worker's poll loop. It is intentionally named like the legacy
 * indexer below to document that this helper is the "other" indexer entry
 * point — see backend/src/services/soroban-indexer.service.ts, which is the
 * LEGACY indexer being phased out. See docs/ARCHITECTURE.md for the full
 * indexer ownership model.
 *
 * NAMING CONVENTION PLAN: once the functional consolidation of the two
 * indexers lands (issue #801), this file is expected to be renamed to
 * `indexer.service.ts` so every service is kebab-case with a `.service.ts`
 * suffix.
 */
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger from '../logger.js';

export interface IndexerStatus {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
  lagSeconds: number;
}

export async function getIndexerStatus(): Promise<IndexerStatus> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });

  const lagSeconds = state
    ? Math.floor((Date.now() - state.updatedAt.getTime()) / 1000)
    : -1;

  return {
    lastLedger: state?.lastLedger ?? 0,
    lastCursor: state?.lastCursor ?? null,
    updatedAt: state?.updatedAt ?? new Date(0),
    lagSeconds,
  };
}

export async function resetIndexer(toLedger: number): Promise<void> {
  await prisma.indexerState.upsert({
    where: { id: INDEXER_STATE_ID },
    create: { id: INDEXER_STATE_ID, lastLedger: toLedger, lastCursor: null },
    update: { lastLedger: toLedger, lastCursor: null },
  });
  logger.info(`[IndexerService] Reset lastProcessedLedger to ${toLedger}`);
}

/**
 * Replay events from a given ledger by resetting state and triggering a poll.
 * The @@unique([transactionHash, eventType]) constraint on StreamEvent
 * guarantees no duplicate StreamEvent rows are created on replay.
 *
 * CAVEAT: This dedup does NOT apply to stream state mutations.
 * Stream.withdrawnAmount (handleTokensWithdrawn, soroban-event-worker.ts:635)
 * is incremented unconditionally on every replay, so replay is NOT fully
 * idempotent. See issue #808 for the withdrawnAmount idempotency fix.
 */
export async function replayFromLedger(fromLedger: number): Promise<void> {
  await resetIndexer(fromLedger);
  // Kick off an immediate poll cycle without waiting for the next interval.
  await sorobanEventWorker.triggerPoll();
  logger.info(`[IndexerService] Replay triggered from ledger ${fromLedger}`);
}
