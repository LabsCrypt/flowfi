import { rpc, xdr, Contract } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import { setIndexerLedgers } from '../lib/metrics.js';
import { withSpan } from '../lib/tracing.js';
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
  setIndexerLedgers(toLedger, 0);
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

/**
 * Record the network tip alongside the indexed ledger so the Prometheus lag
 * gauges stay in step with the poll loop. Called on every polling cycle.
 */
export function publishIndexerLag(currentLedger: number, networkLedger: number): void {
  setIndexerLedgers(currentLedger, networkLedger);
}

// ─── Dead-letter quarantine ───────────────────────────────────────────────────

/**
 * Serializable snapshot of a Soroban event.
 *
 * `topic` and `value` are `xdr.ScVal` instances, which do not survive
 * `JSON.stringify`, so each is stored as base64 XDR and rehydrated on replay.
 */
interface DeadLetterPayload {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
  contractId?: string;
  /** base64 XDR, one entry per topic ScVal. */
  topic: string[];
  /** base64 XDR of the value ScVal. */
  value: string;
}

export function serializeDeadLetterPayload(event: rpc.Api.EventResponse): string {
  const payload: DeadLetterPayload = {
    id: event.id,
    type: String(event.type),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    inSuccessfulContractCall: event.inSuccessfulContractCall,
    topic: event.topic.map((scval) => Buffer.from(scval.toXDR()).toString('base64')),
    value: Buffer.from(event.value.toXDR()).toString('base64'),
  };

  if (event.contractId) {
    payload.contractId =
      typeof event.contractId === 'string' ? event.contractId : event.contractId.toString();
  }

  return JSON.stringify(payload);
}

export function deserializeDeadLetterPayload(payload: string): rpc.Api.EventResponse {
  const parsed = JSON.parse(payload) as DeadLetterPayload;

  const topic = (parsed.topic ?? []).map((b64) =>
    xdr.ScVal.fromXDR(Buffer.from(b64, 'base64')),
  );
  const value = xdr.ScVal.fromXDR(Buffer.from(parsed.value, 'base64'));

  const event = {
    id: parsed.id,
    type: parsed.type,
    ledger: parsed.ledger,
    ledgerClosedAt: parsed.ledgerClosedAt,
    transactionIndex: parsed.transactionIndex,
    operationIndex: parsed.operationIndex,
    inSuccessfulContractCall: parsed.inSuccessfulContractCall,
    topic,
    value,
  } as unknown as rpc.Api.EventResponse;

  if (parsed.contractId) {
    try {
      event.contractId = new Contract(parsed.contractId);
    } catch {
      // A malformed contractId is cosmetic — processing only needs topic/value.
    }
  }

  return event;
}

/** Best-effort event-type label used for dedup and operator filtering. */
function eventTypeOf(event: rpc.Api.EventResponse): string {
  const topic0 = event.topic?.[0];
  if (!topic0) return 'unknown';
  try {
    return topic0.sym().toString();
  } catch {
    return 'unknown';
  }
}

/**
 * Quarantine a contract event whose processing threw.
 *
 * The poll loop deliberately does not retry inline: a payload the handler cannot
 * parse (or a DB lock that survives the retry budget) would otherwise be
 * re-fetched on every cycle and stall the cursor behind it. Writing the event to
 * the dead-letter table lets the loop advance and gives operators a record they
 * can inspect, replay, or discard.
 *
 * Re-quarantining the same event (eventId + eventType) bumps `attempts` and
 * refreshes the error rather than creating a duplicate row.
 */
export async function quarantineEvent(
  event: rpc.Api.EventResponse,
  err: unknown,
  cursor?: string,
): Promise<void> {
  const eventType = eventTypeOf(event);
  const errorMessage = err instanceof Error ? err.message : String(err);

  try {
    await prisma.indexerDeadLetterEvent.upsert({
      where: { eventId_eventType: { eventId: event.id, eventType } },
      create: {
        eventId: event.id,
        eventType,
        txHash: event.txHash,
        ledgerSequence: event.ledger,
        cursor: cursor ?? null,
        payload: serializeDeadLetterPayload(event),
        errorMessage,
        attempts: 1,
        lastAttemptAt: new Date(),
      },
      update: {
        errorMessage,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    logger.error(
      `[IndexerService] Quarantined event ${event.id} (${eventType}) at ledger ${event.ledger}: ${errorMessage}`,
    );
  } catch (dbErr) {
    // Never let quarantine bookkeeping itself kill the poll loop.
    logger.error(
      `[IndexerService] Failed to record dead-letter entry for event ${event.id}:`,
      dbErr,
    );
  }
}

export interface DeadLetterQuery {
  page: number;
  limit: number;
  ledgerSequence?: number;
  startDate?: Date;
  endDate?: Date;
  eventType?: string;
}

export interface DeadLetterListResult {
  items: Array<{
    id: string;
    eventId: string;
    eventType: string;
    txHash: string;
    ledgerSequence: number;
    errorMessage: string;
    attempts: number;
    lastAttemptAt: Date;
    createdAt: Date;
    payload: string;
    cursor: string | null;
  }>;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export const DEFAULT_DEAD_LETTER_PAGE_SIZE = 25;
export const MAX_DEAD_LETTER_PAGE_SIZE = 100;

/** Paginated, filterable read of the dead-letter table. Newest first. */
export async function listDeadLetterEvents(
  query: DeadLetterQuery,
): Promise<DeadLetterListResult> {
  const limit = Math.min(Math.max(1, query.limit || DEFAULT_DEAD_LETTER_PAGE_SIZE), MAX_DEAD_LETTER_PAGE_SIZE);
  const page = Math.max(1, query.page || 1);

  const where: Record<string, unknown> = {};
  if (query.ledgerSequence !== undefined) where['ledgerSequence'] = query.ledgerSequence;
  if (query.eventType) where['eventType'] = query.eventType;
  if (query.startDate || query.endDate) {
    where['createdAt'] = {
      ...(query.startDate ? { gte: query.startDate } : {}),
      ...(query.endDate ? { lte: query.endDate } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.indexerDeadLetterEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { ledgerSequence: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.indexerDeadLetterEvent.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      txHash: row.txHash,
      ledgerSequence: row.ledgerSequence,
      errorMessage: row.errorMessage,
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt,
      createdAt: row.createdAt,
      payload: row.payload,
      cursor: row.cursor,
    })),
    total,
    page,
    limit,
    hasMore: page * limit < total,
  };
}

export type ReplayOutcome = 'replayed' | 'failed' | 'not_found' | 'undecodable';

export interface ReplayResult {
  id: string;
  outcome: ReplayOutcome;
  attempts: number;
  errorMessage?: string;
}

/**
 * Re-inject a quarantined event into the indexer pipeline.
 *
 * On success the dead-letter row is removed and the worker's own handlers write
 * the Stream / StreamEvent records. On failure the row is retained with an
 * incremented attempt count and a refreshed error so the operator can see that
 * the replay was tried and why it still fails.
 */
export async function replayDeadLetterEvent(id: string): Promise<ReplayResult> {
  const record = await prisma.indexerDeadLetterEvent.findUnique({ where: { id } });
  if (!record) {
    return { id, outcome: 'not_found', attempts: 0 };
  }

  let event: rpc.Api.EventResponse;
  try {
    event = deserializeDeadLetterPayload(record.payload);
  } catch (err) {
    // A payload we cannot decode is permanently un-replayable; record why
    // rather than looping on it.
    const errorMessage = `Undecodable dead-letter payload: ${
      err instanceof Error ? err.message : String(err)
    }`;
    await prisma.indexerDeadLetterEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), errorMessage },
    });
    logger.error(`[IndexerService] Dead-letter ${id} payload could not be decoded:`, err);
    return { id, outcome: 'undecodable', attempts: record.attempts + 1, errorMessage };
  }

  try {
    await withSpan('indexer.replay_dead_letter', {
      'dead_letter.id': id,
      'dead_letter.event_type': record.eventType,
      'dead_letter.ledger': record.ledgerSequence,
      'dead_letter.attempts': record.attempts,
    }, async () => {
      await sorobanEventWorker.processEvent(event);
    });

    await prisma.indexerDeadLetterEvent.delete({ where: { id } });
    logger.info(
      `[IndexerService] Replayed dead-letter ${id} (${record.eventType}) at ledger ${record.ledgerSequence}`,
    );
    return { id, outcome: 'replayed', attempts: record.attempts };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const updated = await prisma.indexerDeadLetterEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), errorMessage },
    });

    logger.error(
      `[IndexerService] Replay of dead-letter ${id} failed (attempt ${updated.attempts}): ${errorMessage}`,
    );
    return { id, outcome: 'failed', attempts: updated.attempts, errorMessage };
  }
}

export interface ReplayAllResult {
  attempted: number;
  replayed: number;
  failed: number;
  undecodable: number;
  notFound: number;
  results: ReplayResult[];
}

/**
 * Replay every pending dead-letter record, oldest ledger first, sequentially.
 *
 * Sequential rather than parallel on purpose: replays mutate Stream rows, and
 * two events for the same stream (e.g. `stream_created` then `tokens_withdrawn`)
 * must apply in ledger order or the resulting balances are wrong.
 */
export async function replayAllDeadLetterEvents(): Promise<ReplayAllResult> {
  const pending = await prisma.indexerDeadLetterEvent.findMany({
    orderBy: [{ ledgerSequence: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });

  const results: ReplayResult[] = [];
  for (const row of pending) {
    results.push(await replayDeadLetterEvent(row.id));
  }

  const summary: ReplayAllResult = {
    attempted: results.length,
    replayed: results.filter((r) => r.outcome === 'replayed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    undecodable: results.filter((r) => r.outcome === 'undecodable').length,
    notFound: results.filter((r) => r.outcome === 'not_found').length,
    results,
  };

  logger.info(
    `[IndexerService] Dead-letter replay-all finished: ${summary.replayed}/${summary.attempted} replayed`,
  );
  return summary;
}

/**
 * Permanently discard an unrecoverable dead-letter record.
 *
 * The row is deleted rather than flagged so it stops consuming operator
 * attention, and the discard is written to the application log with the acting
 * admin so the loss of on-chain data remains auditable.
 */
export async function discardDeadLetterEvent(
  id: string,
  discardedBy: string,
): Promise<{ id: string; eventType: string; txHash: string; ledgerSequence: number }> {
  const record = await prisma.indexerDeadLetterEvent.findUnique({ where: { id } });
  if (!record) {
    throw new DeadLetterNotFoundError(id);
  }

  await prisma.indexerDeadLetterEvent.delete({ where: { id } });

  logger.warn(
    `[IndexerService] DISCARDED dead-letter ${id} (${record.eventType}, txHash=${record.txHash}, ` +
      `ledger=${record.ledgerSequence}, attempts=${record.attempts}) by admin ${discardedBy}. ` +
      `This on-chain event will not be indexed.`,
  );

  return {
    id: record.id,
    eventType: record.eventType,
    txHash: record.txHash,
    ledgerSequence: record.ledgerSequence,
  };
}

export class DeadLetterNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Dead-letter event ${id} not found`);
    this.name = 'DeadLetterNotFoundError';
    this.id = id;
  }
}
