import type { Prisma } from '../generated/prisma/index.js';
import logger from '../logger.js';
import { resourceNotFound } from '../lib/api-error.js';
import { lockStreamForUpdate, projectedEndTime } from './top-up-projection.js';

/** The dedup key both top-up writers share. */
const TOPPED_UP = 'TOPPED_UP';

/**
 * `StreamEvent.ledgerSequence` written by the API writer, which has no ledger
 * position. The indexer treats a marker carrying it as chain-unconfirmed and
 * reconciles it against the event it is processing.
 */
const UNINDEXED_MARKER = 0;

/**
 * The API writer: applies a top-up this process just confirmed on chain.
 *
 * `depositedAmount` has two independent writers — this handler (which knows the
 * delta it sent) and the Soroban indexer (which knows the absolute value the
 * contract reported). Both take the stream's row lock and both key their
 * bookkeeping on the same `StreamEvent` `(transactionHash, "TOPPED_UP")` row, so
 * whichever commits second finds the marker and leaves the amount alone. Without
 * the marker the handler used to add the amount on top of the indexer's absolute
 * write, permanently overcounting the stream.
 *
 * Returns the stream's authoritative `depositedAmount` afterwards, whether or not
 * this call is the one that applied it.
 */
export async function applyTopUpOnce(
  tx: Prisma.TransactionClient,
  input: { streamId: bigint; txHash: string; amount: bigint },
): Promise<bigint> {
  if (!(await lockStreamForUpdate(tx, input.streamId))) {
    // Same code the handler's pre-flight read uses, so a caller cannot tell
    // which of the two lookups found nothing.
    throw resourceNotFound('Stream not found', 'NOT_FOUND');
  }

  const recorded = await tx.streamEvent.findUnique({
    where: {
      transactionHash_eventType: {
        transactionHash: input.txHash,
        eventType: TOPPED_UP,
      },
    },
    select: { id: true },
  });

  const stream = await tx.stream.findUniqueOrThrow({
    where: { streamId: input.streamId },
    select: {
      depositedAmount: true,
      ratePerSecond: true,
      startTime: true,
      totalPausedDuration: true,
    },
  });

  if (recorded) {
    logger.info(
      `[topUp] stream=${input.streamId} txHash=${input.txHash} already applied by the indexer, skipping`,
    );
    return BigInt(stream.depositedAmount);
  }

  const depositedAmount = BigInt(stream.depositedAmount) + input.amount;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  await tx.stream.update({
    where: { streamId: input.streamId },
    data: {
      depositedAmount: depositedAmount.toString(),
      endTime: projectedEndTime(depositedAmount, stream),
      lastUpdateTime: timestamp,
    },
  });

  await tx.streamEvent.create({
    data: {
      streamId: input.streamId,
      eventType: TOPPED_UP,
      amount: input.amount.toString(),
      transactionHash: input.txHash,
      // The API writer has no ledger position; the indexer records the real
      // sequence for every event it reads from the chain.
      ledgerSequence: UNINDEXED_MARKER,
      timestamp,
      metadata: JSON.stringify({ newDepositedAmount: depositedAmount.toString() }),
    },
  });

  return depositedAmount;
}

/**
 * The indexer writer: applies a `StreamToppedUp` event read off the chain.
 *
 * Chain state is authoritative, so this path writes the absolute
 * `newDepositedAmount` rather than an increment. An event the indexer has
 * already processed is skipped outright — replaying an older top-up would
 * otherwise roll the row back to that event's (now stale) absolute value.
 *
 * A marker with `ledgerSequence === 0` was written by the API writer, which
 * incremented from whatever the row happened to hold. That value has never been
 * checked against the chain, so this event is its first confirmation and the
 * absolute write is applied as a reconciliation. Skipping it instead would make
 * the API's guess permanent: the dedup marker would block the only writer that
 * knows the true `new_deposited_amount`.
 */
export async function applyToppedUpEvent(
  tx: Prisma.TransactionClient,
  input: {
    streamId: bigint;
    txHash: string;
    amount: string;
    newDepositedAmount: string;
    ledgerSequence: number;
    timestamp: number;
  },
): Promise<void> {
  await lockStreamForUpdate(tx, input.streamId);

  // Check for a duplicate BEFORE mutating any Stream fields so that a
  // replayed event never re-applies the top-up.
  const existingEvent = await tx.streamEvent.findUnique({
    where: {
      transactionHash_eventType: {
        transactionHash: input.txHash,
        eventType: TOPPED_UP,
      },
    },
    select: { id: true, ledgerSequence: true },
  });
  if (existingEvent && existingEvent.ledgerSequence !== UNINDEXED_MARKER) {
    logger.warn(
      `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${input.txHash} type=${TOPPED_UP}`,
    );
    return;
  }
  if (existingEvent) {
    logger.info(
      `[SorobanWorker] Reconciling API-applied top-up against chain: txHash=${input.txHash} ` +
        `chainDeposited=${input.newDepositedAmount}`,
    );
  }

  const stream = await tx.stream.findUniqueOrThrow({
    where: { streamId: input.streamId },
    select: {
      ratePerSecond: true,
      startTime: true,
      totalPausedDuration: true,
    },
  });

  await tx.stream.update({
    where: { streamId: input.streamId },
    data: {
      depositedAmount: input.newDepositedAmount,
      endTime: projectedEndTime(BigInt(input.newDepositedAmount), stream),
      lastUpdateTime: input.timestamp,
    },
  });

  await tx.streamEvent.upsert({
    where: {
      transactionHash_eventType: {
        transactionHash: input.txHash,
        eventType: TOPPED_UP,
      },
    },
    create: {
      streamId: input.streamId,
      eventType: TOPPED_UP,
      amount: input.amount,
      transactionHash: input.txHash,
      ledgerSequence: input.ledgerSequence,
      timestamp: BigInt(input.timestamp),
      metadata: JSON.stringify({ newDepositedAmount: input.newDepositedAmount }),
    },
    update: {
      ledgerSequence: input.ledgerSequence,
      timestamp: BigInt(input.timestamp),
    },
  });
}
