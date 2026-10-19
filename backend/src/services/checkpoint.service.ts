import { createHash } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import {
  indexerReorgEventsTotal,
  setIndexerRevertedLedgers,
} from '../lib/metrics.js';
import logger from '../logger.js';
import type { Prisma } from '../generated/prisma/index.js';

/**
 * Ledger checkpointing + fork/reorg recovery engine (issue #1468).
 *
 * The Soroban event worker writes checkpoints as it ingests; this module both
 * records them and, on the next cycle, re-proves them against the canonical
 * chain. When a checkpoint no longer matches the ledger the RPC node serves at
 * that sequence, the chain we indexed has been replaced by a fork, so every
 * mutation above the last still-canonical ledger is rolled back inside a single
 * database transaction and the affected stream rows are recomputed from the
 * surviving event log.
 */

/** Rollbacks larger than this are treated as a critical incident and quarantined. */
export const DEFAULT_REORG_ALERT_THRESHOLD = 5;

/** How far back `detectReorg` walks looking for the last still-canonical checkpoint. */
export const DEFAULT_REORG_WALK_BACK = 32;

/** Synthetic dead-letter `eventType` used to surface a large rollback for triage. */
export const REORG_DEAD_LETTER_EVENT_TYPE = 'ledger_reorg';

/** Canonical header for a single ledger. `parentHash` is best-effort (may be ''). */
export interface LedgerHeader {
  sequence: number;
  hash: string;
  parentHash: string;
}

/** Resolves the canonical header for a ledger sequence, or null if unavailable. */
export type LedgerHeaderFetcher = (sequence: number) => Promise<LedgerHeader | null>;

export interface RecordCheckpointInput {
  sequence: number;
  hash: string;
  parentHash: string;
  eventsCount: number;
  stateRootHash?: string | null;
}

export interface ReorgDetection {
  /** True when at least one checkpoint no longer matches the canonical chain. */
  reorg: boolean;
  /** Newest checkpoint that still matches; null when none of the walked set does. */
  verifiedLedger: number | null;
  /** Highest ledger known to be canonical; everything above it is invalid. */
  safeLedger: number;
  /** First ledger to be reverted (`safeLedger + 1`) when a reorg was detected. */
  firstInvalidLedger: number | null;
  /** Number of checkpoints re-fetched from the RPC node. */
  checked: number;
  /** True when the RPC node could not be reached for a checkpoint (fail-safe). */
  unverifiable: boolean;
}

export interface RollbackResult {
  safeLedger: number;
  eventsDeleted: number;
  streamsRecomputed: number;
  streamsDeleted: number;
  checkpointsReverted: number;
  /** Number of distinct ledger sequences that held reverted events. */
  ledgersRolledBack: number;
  highestRevertedLedger: number | null;
}

export interface ReorgRecoveryResult {
  detected: boolean;
  detection: ReorgDetection;
  rollback: RollbackResult | null;
  /** True when the rollback exceeded the configured ledger ceiling. */
  exceededThreshold: boolean;
  /** True when a triage dead-letter row was written for the rollback. */
  quarantined: boolean;
}

export interface ReorgRecoveryOptions {
  /** Ledger ceiling above which a rollback is escalated to triage. Default 5. */
  alertThreshold?: number;
  /** Maximum checkpoints to re-verify before giving up the walk-back. Default 32. */
  maxWalkBack?: number;
  /** Set false to skip the escalation dead-letter write (unit tests). */
  quarantine?: boolean;
}

interface EventFingerprint {
  ledgerSequence?: number;
  transactionHash?: string;
  eventType?: string;
  id?: string;
}

/**
 * Deterministic digest over an ingestion cycle's events.
 *
 * Order-independent (the batch is sorted before hashing) so two cycles that
 * ingest the same events in a different fetch order produce the same root,
 * which keeps the checkpoint comparable across RPC failovers.
 */
export function computeStateRootHash(events: EventFingerprint[]): string {
  const canonical = events
    .map(
      (event) =>
        `${event.ledgerSequence ?? ''}:${event.transactionHash ?? ''}:${event.eventType ?? event.id ?? ''}`,
    )
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Persist (or refresh) the checkpoint for one ingested ledger. */
export async function recordCheckpoint(input: RecordCheckpointInput): Promise<void> {
  const stateRootHash = input.stateRootHash ?? null;
  await prisma.ledgerCheckpoint.upsert({
    where: { ledgerSequence: input.sequence },
    create: {
      ledgerSequence: input.sequence,
      ledgerHash: input.hash,
      parentHash: input.parentHash,
      eventsCount: input.eventsCount,
      stateRootHash,
      isReverted: false,
    },
    update: {
      ledgerHash: input.hash,
      parentHash: input.parentHash,
      eventsCount: input.eventsCount,
      stateRootHash,
      isReverted: false,
      processedAt: new Date(),
    },
  });
}

/** Most recent checkpoint, optionally including ledgers already rolled back. */
export async function getLatestCheckpoint(includeReverted = false) {
  return prisma.ledgerCheckpoint.findFirst({
    where: includeReverted ? {} : { isReverted: false },
    orderBy: { ledgerSequence: 'desc' },
  });
}

/** Newest-first checkpoint page, used by the operator reorg status endpoint. */
export async function listRecentCheckpoints(limit = 20) {
  return prisma.ledgerCheckpoint.findMany({
    orderBy: { ledgerSequence: 'desc' },
    take: Math.min(Math.max(1, limit), 100),
  });
}

/**
 * Re-prove the newest checkpoints against the canonical chain.
 *
 * The walk is newest-first and stops at the first checkpoint whose stored hash
 * still matches the header the RPC node serves. Everything above that ledger is
 * therefore part of a replaced fork.
 *
 * Fail-safe behaviour: if the RPC node cannot be reached for a checkpoint we
 * return `reorg: false` rather than guessing. A transient RPC outage must never
 * trigger a destructive rollback.
 */
export async function detectReorg(
  fetchHeader: LedgerHeaderFetcher,
  options: ReorgRecoveryOptions = {},
): Promise<ReorgDetection> {
  const maxWalkBack = options.maxWalkBack ?? DEFAULT_REORG_WALK_BACK;
  const checkpoints = await prisma.ledgerCheckpoint.findMany({
    where: { isReverted: false },
    orderBy: { ledgerSequence: 'desc' },
    take: maxWalkBack,
  });

  if (checkpoints.length === 0) {
    return {
      reorg: false,
      verifiedLedger: null,
      safeLedger: 0,
      firstInvalidLedger: null,
      checked: 0,
      unverifiable: false,
    };
  }

  const newest = checkpoints[0]!.ledgerSequence;
  let verified: number | null = null;
  let checked = 0;

  for (const checkpoint of checkpoints) {
    let header: LedgerHeader | null = null;
    try {
      header = await fetchHeader(checkpoint.ledgerSequence);
    } catch {
      header = null;
    }
    checked += 1;

    if (!header) {
      // Cannot verify right now — do not destroy data on a transient failure.
      return {
        reorg: false,
        verifiedLedger: verified,
        safeLedger: verified ?? 0,
        firstInvalidLedger: null,
        checked,
        unverifiable: true,
      };
    }

    if (header.hash === checkpoint.ledgerHash) {
      verified = checkpoint.ledgerSequence;
      break;
    }
  }

  if (verified === newest) {
    return {
      reorg: false,
      verifiedLedger: verified,
      safeLedger: verified,
      firstInvalidLedger: null,
      checked,
      unverifiable: false,
    };
  }

  const lowestChecked = checkpoints[checkpoints.length - 1]!.ledgerSequence;
  const safeLedger = verified ?? Math.max(0, lowestChecked - 1);

  return {
    reorg: true,
    verifiedLedger: verified,
    safeLedger,
    firstInvalidLedger: safeLedger + 1,
    checked,
    unverifiable: false,
  };
}

/**
 * Revert every stream mutation and event above `safeLedger` atomically.
 *
 * Steps, all inside one `$transaction` so a crash can never leave the cursor
 * advanced past partially-reverted rows:
 *  1. Snapshot the streams and ledger sequences that own reverted events.
 *  2. Delete the reverted StreamEvent rows.
 *  3. Recompute each affected stream's balance/status from the survivors.
 *  4. Flag the reverted checkpoints (isReverted = true).
 *  5. Rewind the indexer cursor to `safeLedger` with a null cursor so the next
 *     poll re-ingests the canonical sequence from that ledger forward.
 */
export async function rollbackAboveLedger(safeLedger: number): Promise<RollbackResult> {
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const affected = await tx.streamEvent.findMany({
      where: { ledgerSequence: { gt: safeLedger } },
      select: { streamId: true, ledgerSequence: true },
    });

    const streamIds = [...new Set(affected.map((event) => event.streamId))];
    const ledgers = [...new Set(affected.map((event) => event.ledgerSequence))].sort(
      (a, b) => a - b,
    );
    const highestRevertedLedger = ledgers.length > 0 ? ledgers[ledgers.length - 1]! : null;

    const deleted = await tx.streamEvent.deleteMany({
      where: { ledgerSequence: { gt: safeLedger } },
    });

    let streamsRecomputed = 0;
    let streamsDeleted = 0;
    for (const streamId of streamIds) {
      const outcome = await recomputeStreamState(tx, streamId);
      if (outcome === 'updated') streamsRecomputed += 1;
      if (outcome === 'deleted') streamsDeleted += 1;
    }

    const reverted = await tx.ledgerCheckpoint.updateMany({
      where: { ledgerSequence: { gt: safeLedger }, isReverted: false },
      data: { isReverted: true },
    });

    await tx.indexerState.upsert({
      where: { id: INDEXER_STATE_ID },
      create: { id: INDEXER_STATE_ID, lastLedger: safeLedger, lastCursor: null },
      update: { lastLedger: safeLedger, lastCursor: null },
    });

    return {
      eventsDeleted: deleted.count,
      streamsRecomputed,
      streamsDeleted,
      checkpointsReverted: reverted.count,
      ledgersRolledBack: ledgers.length,
      highestRevertedLedger,
    };
  });

  return { safeLedger, ...result };
}

/**
 * Detect a reorg, roll it back, and escalate if the damage is large enough.
 *
 * Returns `{ detected: false }` when the chain still matches, so callers can
 * invoke this unconditionally before ingesting.
 */
export async function verifyAndRecover(
  fetchHeader: LedgerHeaderFetcher,
  options: ReorgRecoveryOptions = {},
): Promise<ReorgRecoveryResult> {
  const detection = await detectReorg(fetchHeader, options);

  if (!detection.reorg) {
    return {
      detected: false,
      detection,
      rollback: null,
      exceededThreshold: false,
      quarantined: false,
    };
  }

  logger.error(
    `[CheckpointService] Ledger reorg detected: checkpoint at ledger ${detection.firstInvalidLedger} ` +
      `no longer matches the canonical chain (verified through ledger ${detection.verifiedLedger ?? 'none'}). ` +
      `Rolling back to ledger ${detection.safeLedger}.`,
  );

  const rollback = await rollbackAboveLedger(detection.safeLedger);
  indexerReorgEventsTotal.inc({ outcome: 'rolled_back' });
  setIndexerRevertedLedgers(rollback.ledgersRolledBack);

  const threshold = options.alertThreshold ?? DEFAULT_REORG_ALERT_THRESHOLD;
  const exceededThreshold = rollback.ledgersRolledBack > threshold;

  if (exceededThreshold) {
    logger.error(
      `[CheckpointService] CRITICAL: rollback reverted ${rollback.ledgersRolledBack} ledgers ` +
        `(threshold ${threshold}); escalating to dead-letter triage.`,
    );
  }

  let quarantined = false;
  if (exceededThreshold && options.quarantine !== false) {
    quarantined = await recordReorgDeadLetter(detection, rollback);
  }

  logger.warn(
    `[CheckpointService] Reorg rollback complete: deleted ${rollback.eventsDeleted} event(s), ` +
      `recomputed ${rollback.streamsRecomputed} stream(s), deleted ${rollback.streamsDeleted} ` +
      `stream(s), reverted ${rollback.checkpointsReverted} checkpoint(s). ` +
      `Resuming ingestion from ledger ${rollback.safeLedger}.`,
  );

  return { detected: true, detection, rollback, exceededThreshold, quarantined };
}

type RecomputeOutcome = 'updated' | 'deleted' | 'missing' | 'unchanged';

/**
 * Rebuild one stream row purely from the events that survived the rollback.
 *
 * A full replay (rather than an inverse delta) is what removes balance drift:
 * withdrawals are re-summed, deposits re-derived from the latest absolute
 * `newDepositedAmount`, and status flags replayed in ledger order.
 */
async function recomputeStreamState(
  tx: Prisma.TransactionClient,
  streamId: bigint,
): Promise<RecomputeOutcome> {
  const stream = await tx.stream.findUnique({ where: { streamId } });
  if (!stream) return 'missing';

  const events = await tx.streamEvent.findMany({
    where: { streamId },
    orderBy: [{ ledgerSequence: 'asc' }, { timestamp: 'asc' }],
  });

  // Every event for a stream created inside the reverted range is gone: the
  // stream itself only ever existed on the discarded fork.
  if (events.length === 0) {
    if (streamId === 0n) return 'unchanged';
    await tx.stream.delete({ where: { streamId } });
    return 'deleted';
  }

  const rate = BigInt(stream.ratePerSecond);
  const startTime = stream.startTime;
  let deposited = BigInt(stream.depositedAmount);
  let withdrawn = 0n;
  let isActive = stream.isActive;
  let isPaused = stream.isPaused;
  let pausedAt = stream.pausedAt;
  let totalPausedDuration = stream.totalPausedDuration;
  let lastUpdateTime = stream.lastUpdateTime;
  let endTime = stream.endTime;
  let sawRelevantEvent = false;

  for (const event of events) {
    const metadata = parseMetadata(event.metadata);
    switch (event.eventType) {
      case 'CREATED': {
        sawRelevantEvent = true;
        if (event.amount) deposited = BigInt(event.amount);
        isActive = true;
        endTime = rate === 0n ? null : startTime + deposited / rate;
        lastUpdateTime = event.timestamp;
        break;
      }
      case 'TOPPED_UP': {
        sawRelevantEvent = true;
        const newDeposited = metadata['newDepositedAmount'];
        if (typeof newDeposited === 'string') deposited = BigInt(newDeposited);
        else if (event.amount) deposited += BigInt(event.amount);
        endTime =
          rate === 0n
            ? null
            : startTime + deposited / rate + BigInt(totalPausedDuration);
        lastUpdateTime = event.timestamp;
        break;
      }
      case 'WITHDRAWN': {
        sawRelevantEvent = true;
        if (event.amount) withdrawn += BigInt(event.amount);
        lastUpdateTime = event.timestamp;
        break;
      }
      case 'CANCELLED': {
        sawRelevantEvent = true;
        isActive = false;
        const amountWithdrawn = metadata['amountWithdrawn'];
        if (typeof amountWithdrawn === 'string') withdrawn = BigInt(amountWithdrawn);
        lastUpdateTime = event.timestamp;
        break;
      }
      case 'COMPLETED': {
        sawRelevantEvent = true;
        isActive = false;
        if (event.amount) withdrawn = BigInt(event.amount);
        lastUpdateTime = event.timestamp;
        break;
      }
      case 'PAUSED': {
        sawRelevantEvent = true;
        isPaused = true;
        const paused = metadata['pausedAt'];
        if (typeof paused === 'number') pausedAt = BigInt(paused);
        else if (typeof paused === 'string') pausedAt = BigInt(paused);
        lastUpdateTime = event.timestamp;
        break;
      }
      case 'RESUMED': {
        sawRelevantEvent = true;
        isPaused = false;
        pausedAt = null;
        const total = metadata['totalPausedDuration'];
        if (typeof total === 'number') totalPausedDuration = total;
        const newEndTime = metadata['newEndTime'];
        if (typeof newEndTime === 'string') endTime = BigInt(newEndTime);
        lastUpdateTime = event.timestamp;
        break;
      }
      default:
        break;
    }
  }

  if (!sawRelevantEvent) return 'unchanged';

  await tx.stream.update({
    where: { streamId },
    data: {
      depositedAmount: deposited.toString(),
      withdrawnAmount: withdrawn.toString(),
      isActive,
      isPaused,
      pausedAt,
      totalPausedDuration,
      endTime,
      lastUpdateTime,
    },
  });

  return 'updated';
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Write a triage row when a rollback reverted more ledgers than the threshold.
 *
 * Reuses the existing dead-letter table so an operator sees the incident in the
 * same triage workflow as a quarantined event, without inventing a parallel
 * alert pipeline. Never throws: a failed escalation must not mask the rollback.
 */
async function recordReorgDeadLetter(
  detection: ReorgDetection,
  rollback: RollbackResult,
): Promise<boolean> {
  const firstInvalid = detection.firstInvalidLedger ?? rollback.safeLedger + 1;
  const eventId = `reorg:${firstInvalid}:${Date.now()}`;
  const errorMessage =
    `Ledger reorg rolled back ${rollback.ledgersRolledBack} ledger(s) ` +
    `(above safe ledger ${rollback.safeLedger})`;

  try {
    await prisma.indexerDeadLetterEvent.upsert({
      where: {
        eventId_eventType: { eventId, eventType: REORG_DEAD_LETTER_EVENT_TYPE },
      },
      create: {
        eventId,
        eventType: REORG_DEAD_LETTER_EVENT_TYPE,
        txHash: eventId,
        ledgerSequence: firstInvalid,
        cursor: null,
        payload: JSON.stringify({ detection, rollback, recordedAt: new Date().toISOString() }),
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
    return true;
  } catch (err) {
    logger.error('[CheckpointService] Failed to record reorg dead-letter entry:', err);
    return false;
  }
}
