/**
 * Math utilities for FlowFi payment streams (#1658).
 * Pure bigint arithmetic with zero floating-point precision loss.
 */

/**
 * Calculates the tokens dripped per second from total deposit amount and stream duration.
 *
 * @param totalAmount - Total deposit amount in stroops (must be > 0n).
 * @param durationSeconds - Stream duration in seconds (must be > 0n).
 * @returns BigInt rate per second in stroops.
 * @throws {RangeError} If totalAmount <= 0n or durationSeconds <= 0n.
 */
export function calculateRatePerSecond(totalAmount: bigint, durationSeconds: bigint): bigint {
  if (totalAmount <= 0n) {
    throw new RangeError('calculateRatePerSecond: totalAmount must be greater than 0');
  }
  if (durationSeconds <= 0n) {
    throw new RangeError('calculateRatePerSecond: durationSeconds must be greater than 0');
  }
  return totalAmount / durationSeconds;
}

/**
 * Calculates the aligned deposit amount required for a given rate per second and duration.
 * Eliminates off-by-one residue mismatches when creating streams.
 *
 * @param ratePerSecond - Token rate per second in stroops (must be > 0n).
 * @param durationSeconds - Stream duration in seconds (must be > 0n).
 * @returns BigInt total aligned deposit in stroops.
 * @throws {RangeError} If ratePerSecond <= 0n or durationSeconds <= 0n.
 */
export function calculateAlignedDeposit(ratePerSecond: bigint, durationSeconds: bigint): bigint {
  if (ratePerSecond <= 0n) {
    throw new RangeError('calculateAlignedDeposit: ratePerSecond must be greater than 0');
  }
  if (durationSeconds <= 0n) {
    throw new RangeError('calculateAlignedDeposit: durationSeconds must be greater than 0');
  }
  return ratePerSecond * durationSeconds;
}

/** Alias for calculateAlignedDeposit (#1658). */
export const calculateRequiredDeposit = calculateAlignedDeposit;
