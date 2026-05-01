import { cache } from '../lib/redis.js';

const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

export interface ClaimableStreamState {
  streamId: number;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  lastUpdateTime: number;
  isActive: boolean;
  isPaused: boolean;
  pausedAt: number | null;
  totalPausedDuration: number;
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
    stream.startTime,
    stream.lastUpdateTime,
    stream.isActive ? '1' : '0',
    stream.isPaused ? '1' : '0',
    stream.pausedAt ?? 'null',
    stream.totalPausedDuration,
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
  private readonly cacheTtlMs: number;
  private readonly nowMs: () => number;

  constructor(options: ClaimableServiceOptions = {}) {
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5000); // Default to 5s as per Issue #377
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  clearCache(): void {
    // Internal cache is handled by redis/MemoryCache cleanup
  }

  getClaimableAmount(
    stream: ClaimableStreamState,
    requestedAt?: number,
  ): ClaimableAmountResult {
    const calculatedAt =
      requestedAt !== undefined
        ? Math.floor(requestedAt)
        : Math.floor(this.nowMs() / 1000);

    const cacheKey = `claimable:${stream.streamId}:${getStateFingerprint(stream)}:${calculatedAt}`;
    const cachedEntry = cache.get<Omit<ClaimableAmountResult, 'cached'>>(cacheKey);

    if (cachedEntry) {
      const metadata = cache.getMetadata(cacheKey);
      return {
        ...cachedEntry,
        cached: true,
        cachedAt: metadata?.createdAt
      } as any;
    }

    const anchorTime = BigInt(Math.max(0, stream.lastUpdateTime));
    const nowTs = BigInt(Math.max(0, calculatedAt));
    let elapsed = nowTs > anchorTime ? nowTs - anchorTime : 0n;

    // Paused duration is handled by the contract updating lastUpdateTime on resume,
    // but we still account for it if it's currently paused.
    if (stream.isPaused && stream.pausedAt !== null) {
      const currentPauseStart = BigInt(Math.max(0, stream.pausedAt));
      if (nowTs > currentPauseStart) {
        const currentPauseDuration = nowTs - currentPauseStart;
        elapsed = elapsed > currentPauseDuration ? elapsed - currentPauseDuration : 0n;
      }
    }

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

    cache.set(cacheKey, value, this.cacheTtlMs / 1000);

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

