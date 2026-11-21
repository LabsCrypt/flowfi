/**
 * Stream identifiers, and how to turn one into the number the contract wants.
 *
 * A stream has two identifiers and they are not interchangeable: `streamId` is
 * the on-chain u64, while `id` is the database UUID. `BigInt(id.replace(/\D/g,
 * ""))` looked forgiving and was not — on a UUID it strips every letter and
 * dash, and what is left is either `0n` or a truncated number, so a withdrawal
 * could be submitted against a stream that is not the one on screen (#1883).
 *
 * Everything that builds a contract call from a stream now goes through
 * `parseStreamId`, which either returns the right id or nothing at all.
 */

const UINT_PATTERN = /^\d+$/;

/**
 * Parses an on-chain stream id.
 *
 * Accepts a bigint, a non-negative safe integer, or a string of digits — the
 * same shapes the API and the chain read return. Anything else (a UUID, an
 * empty string, a negative number, a float, `"0x1f"`) is `null`: a caller must
 * treat that as "this row cannot be submitted" rather than as zero.
 */
export function parseStreamId(value: string | number | bigint | null | undefined): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!UINT_PATTERN.test(trimmed)) {
    return null;
  }

  return BigInt(trimmed);
}

/** True when the value can be submitted as an on-chain stream id. */
export function isOnChainStreamId(value: string | number | bigint | null | undefined): boolean {
  return parseStreamId(value) !== null;
}
