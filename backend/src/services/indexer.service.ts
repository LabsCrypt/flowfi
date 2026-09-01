import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger, { requestContext } from '../logger.js';

export interface IndexerStatus {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
  lagSeconds: number;
}

export async function getIndexerStatus(): Promise<IndexerStatus> {
  const state = await prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } });
  const lagSeconds = state ? Math.floor((Date.now() - state.updatedAt.getTime()) / 1000) : -1;
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
 * Preview what a reset would do without mutating state.
 * Returns the current cursor and the target ledger so operators can
 * verify the intended scope before committing.
 */
export interface ResetPreview {
  currentLastLedger: number;
  currentLastCursor: string | null;
  targetLastLedger: number;
}

export async function previewReset(targetLedger: number): Promise<ResetPreview> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  return {
    currentLastLedger: state?.lastLedger ?? 0,
    currentLastCursor: state?.lastCursor ?? null,
    targetLastLedger: targetLedger,
  };
}

/**
 * Preview what a replay from a given ledger would do without mutating state.
 * Returns the event count, ledger range, and current cursor so operators can
 * sanity-check before committing a destructive replay.
 */
export interface ReplayPreview {
  fromLedger: number;
  currentLastLedger: number;
  currentLastCursor: string | null;
  eventCount: number;
  minLedgerInReplayRange: number | null;
  maxLedgerInReplayRange: number | null;
}

export async function previewReplay(
  fromLedger: number,
): Promise<ReplayPreview> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  const currentLastLedger = state?.lastLedger ?? 0;

  const rangeFilter: import('../generated/prisma/index.js').Prisma.StreamEventWhereInput =
    currentLastLedger > 0
      ? { ledgerSequence: { gte: fromLedger, lte: currentLastLedger } }
      : { ledgerSequence: { gte: fromLedger } };

  const [eventCount, aggregate] = await Promise.all([
    prisma.streamEvent.count({ where: rangeFilter }),
    prisma.streamEvent.aggregate({
      where: rangeFilter,
      _min: { ledgerSequence: true },
      _max: { ledgerSequence: true },
    }),
  ]);

  return {
    fromLedger,
    currentLastLedger,
    currentLastCursor: state?.lastCursor ?? null,
    eventCount,
    minLedgerInReplayRange: aggregate._min.ledgerSequence,
    maxLedgerInReplayRange: aggregate._max.ledgerSequence,
  };
}

export async function replayFromLedger(fromLedger: number, customRequestId?: string): Promise<string> {
  const requestId = customRequestId || requestContext.getStore()?.requestId || randomUUID();
  return requestContext.run({ requestId }, async () => {
    await resetIndexer(fromLedger);
    await sorobanEventWorker.triggerPoll(requestId);
    logger.info(`[IndexerService] Replay triggered from ledger ${fromLedger}`);
    return requestId;
  });
}
