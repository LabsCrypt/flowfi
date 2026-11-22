import type { Prisma } from '../generated/prisma/index.js';

/** The fields `endTime` is derived from, as stored on a `Stream` row. */
export interface StreamTiming {
  ratePerSecond: string | bigint;
  startTime: bigint;
  totalPausedDuration: number | bigint;
}

/**
 * The wall-clock time a stream runs out of deposit.
 *
 * Both writers of `depositedAmount` — the top-up API handler and the Soroban
 * event indexer — must extend `endTime` with this same formula, otherwise the
 * two paths disagree about when a stream ends depending on which one committed.
 * A zero rate means the deposit buys no runway, so the projection is unknown
 * rather than a division by zero.
 */
export function projectedEndTime(
  depositedAmount: bigint,
  stream: StreamTiming,
): bigint | null {
  const ratePerSecond = BigInt(stream.ratePerSecond);
  if (ratePerSecond === 0n) return null;
  return (
    stream.startTime +
    depositedAmount / ratePerSecond +
    BigInt(stream.totalPausedDuration)
  );
}

/**
 * Takes the `FOR UPDATE` row lock on one stream for the surrounding
 * transaction, so that concurrent writers of its amounts serialise instead of
 * interleaving a read-compute-write. Returns false when no such row exists.
 */
export async function lockStreamForUpdate(
  tx: Prisma.TransactionClient,
  streamId: bigint,
): Promise<boolean> {
  const locked = await tx.$executeRaw`SELECT 1 FROM "Stream" WHERE "streamId" = ${streamId} FOR UPDATE`;
  return locked > 0;
}
