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

export async function replayFromLedger(fromLedger: number, customRequestId?: string): Promise<string> {
  const requestId = customRequestId || requestContext.getStore()?.requestId || randomUUID();
  return requestContext.run({ requestId }, async () => {
    await resetIndexer(fromLedger);
    await sorobanEventWorker.triggerPoll(requestId);
    logger.info(`[IndexerService] Replay triggered from ledger ${fromLedger}`);
    return requestId;
  });
}
