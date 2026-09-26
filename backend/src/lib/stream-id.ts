/**
 * Helpers for on-chain stream IDs (Soroban u64).
 *
 * DB columns are Prisma BigInt / Postgres bigint so values above int4 max
 * (2_147_483_647) round-trip without overflow. Prefer bigint in application
 * code; never use Number()/parseInt for identifiers that may exceed 2^53-1.
 */

const U64_DECIMAL = /^\d+$/;

/**
 * Parse a path/query/body streamId into a bigint.
 * Accepts decimal strings and non-negative integers / bigints.
 */
export function parseStreamId(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') {
    return raw >= 0n ? raw : null;
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
      return null;
    }
    return BigInt(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!U64_DECIMAL.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * JSON-safe encoding: numbers stay numbers within Number.MAX_SAFE_INTEGER
 * (covers all historical int4 IDs and the >2^31 cases the bug cares about
 * until 2^53); larger u64 values become decimal strings.
 */
export function streamIdToJson(streamId: bigint): number | string {
  const asNumber = Number(streamId);
  return Number.isSafeInteger(asNumber) ? asNumber : streamId.toString();
}

// Ensure Express / SSE JSON.stringify can serialize Prisma BigInt fields.
const bigIntProto = BigInt.prototype as unknown as { toJSON?: () => number | string };
if (typeof bigIntProto.toJSON !== 'function') {
  bigIntProto.toJSON = function bigIntToJSON(this: bigint) {
    return streamIdToJson(this);
  };
}
