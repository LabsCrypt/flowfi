const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

export interface ClaimableStreamState {
  streamId: number;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  lastUpdateTime: number;
  isActive: boolean;
  updatedAt?: Date;
}

export interface ClaimableAmountResult {
  streamId: number;
  claimableAmount: string;
  actionable: boolean;
  calculatedAt: number;
  cached: boolean;
}

interface ClaimableCacheEntry {
  value: Omit<ClaimableAmountResult, 'cached'>;
  expiresAtMs: number;
}

interface ClaimableServiceOptions {
  cacheTtlMs?: number;
  nowMs?: () => number;
}

function clampI128(value: bigint): bigint {
  if (value > I128_MAX) return I128_MAX;
  if (value < I128_MIN) return I128_MIN;
  return value;
}

function saturatingSubI128(a: bigint, b: bigint): bigint {
  return clampI128(a - b);
}

function saturatingMulI128(a: bigint, b: bigint): bigint {
  return clampI128(a * b);
}

function parseI128(value: string, fieldName: string): bigint {
  try {
    return clampI128(BigInt(value));
  } catch {
    throw new Error(`Invalid i128 value for '${fieldName}'`);
  }
}

function getStateFingerprint(stream: ClaimableStreamState): string {
  if (stream.updatedAt) {
    return String(stream.updatedAt.getTime());
  }

  return [
    stream.ratePerSecond,
    stream.depositedAmount,
    stream.withdrawnAmount,
    stream.lastUpdateTime,
    stream.isActive ? '1' : '0',
  ].join(':');
}

/**
 * Mirrors Soroban's overflow-safe claimable calculation:
 * - elapsed = now.saturating_sub(last_update_time)
 * - streamed = (elapsed * rate_per_second) with i128 saturation
 * - remaining = deposited_amount.saturating_sub(withdrawn_amount)
 * - claimable = min(streamed, remaining)
 */
export class ClaimableAmountService {
  private readonly cache = new Map<string, ClaimableCacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly nowMs: () => number;

  constructor(options: ClaimableServiceOptions = {}) {
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 1000);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  clearCache(): void {
    this.cache.clear();
  }

  getClaimableAmount(
    stream: ClaimableStreamState,
    requestedAt?: number,
  ): ClaimableAmountResult {
    const calculatedAt =
      requestedAt !== undefined
        ? Math.floor(requestedAt)
        : Math.floor(this.nowMs() / 1000);

    const cacheKey = `${stream.streamId}:${getStateFingerprint(stream)}:${calculatedAt}`;
    const nowMs = this.nowMs();
    const cachedEntry = this.cache.get(cacheKey);

    if (cachedEntry && cachedEntry.expiresAtMs > nowMs) {
      return {
        ...cachedEntry.value,
        cached: true,
      };
    }

    const streamLastUpdate = BigInt(Math.max(0, stream.lastUpdateTime));
    const nowTs = BigInt(Math.max(0, calculatedAt));
    const elapsed = nowTs > streamLastUpdate ? nowTs - streamLastUpdate : 0n;

    const ratePerSecond = parseI128(stream.ratePerSecond, 'ratePerSecond');
    const depositedAmount = parseI128(stream.depositedAmount, 'depositedAmount');
    const withdrawnAmount = parseI128(stream.withdrawnAmount, 'withdrawnAmount');

    const streamedAmount = saturatingMulI128(elapsed, ratePerSecond);
    const remainingAmount = saturatingSubI128(depositedAmount, withdrawnAmount);
    const rawClaimable =
      streamedAmount > remainingAmount ? remainingAmount : streamedAmount;

    // "Actionable" mirrors what a client can withdraw right now.
    const actionableAmount =
      stream.isActive && rawClaimable > 0n ? rawClaimable : 0n;

    const value: Omit<ClaimableAmountResult, 'cached'> = {
      streamId: stream.streamId,
      claimableAmount: actionableAmount.toString(),
      actionable: actionableAmount > 0n,
      calculatedAt,
    };

    this.cache.set(cacheKey, {
      value,
      expiresAtMs: nowMs + this.cacheTtlMs,
    });

    return {
      ...value,
      cached: false,
    };
  }
}

const configuredCacheTtlMs = Number.parseInt(
  process.env.CLAIMABLE_CACHE_TTL_MS ?? '1000',
  10,
);

export const claimableAmountService = new ClaimableAmountService({
  cacheTtlMs: Number.isFinite(configuredCacheTtlMs) ? configuredCacheTtlMs : 1000,
});

