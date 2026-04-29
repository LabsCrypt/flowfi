import { prisma } from '../lib/prisma.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger from '../logger.js';

const INDEXER_STATE_ID = 'singleton';

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
 * Deduplication in the worker (transactionHash + eventType + ledger) ensures
 * no duplicate StreamEvent rows are created.
 */
export async function replayFromLedger(fromLedger: number): Promise<void> {
  await resetIndexer(fromLedger);
  // Kick off an immediate poll cycle without waiting for the next interval.
  await sorobanEventWorker.triggerPoll().catch((err: unknown) => {
    logger.error('[IndexerService] Replay poll error:', err);
  });
  logger.info(`[IndexerService] Replay triggered from ledger ${fromLedger}`);
}
