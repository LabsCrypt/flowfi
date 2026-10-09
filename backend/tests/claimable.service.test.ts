import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ClaimableAmountService, calculateHistoricalStreamSnapshot } from '../src/services/claimable.service.js';

function makeStreamState(overrides: Partial<Parameters<ClaimableAmountService['getClaimableAmount']>[0]> = {}) {
  return {
    streamId: 1n,
    tokenAddress: 'TOKEN_DEFAULT',
    ratePerSecond: '10',
    depositedAmount: '100',
    withdrawnAmount: '0',
    lastUpdateTime: 0,
    startTime: 0n,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    ...overrides,
  };
}

describe('ClaimableAmountService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calculates claimable amount for active stream', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
    });

    vi.setSystemTime(10_000);

    const result = service.getClaimableAmount({
      ...makeStreamState({
        streamId: 1n,
        ratePerSecond: '5',
        depositedAmount: '500',
        withdrawnAmount: '100',
        lastUpdateTime: 7,
      }),
    });

    // elapsed = now(10s) - lastUpdateTime(7s) = 3s
    // streamed = 3 * 5 = 15
    // remaining = 500 - 100 = 400
    // claimable = min(15, 400) = 15
    expect(result.claimableAmount).toBe('15');
    expect(result.actionable).toBe(true);
    expect(result.cached).toBe(false);
  });

  it('caps claimable amount at remaining balance', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
    });

    vi.setSystemTime(100_000);

    const result = service.getClaimableAmount({
      ...makeStreamState({
        streamId: 2n,
        depositedAmount: '1000',
        withdrawnAmount: '900',
      }),
    });

    expect(result.claimableAmount).toBe('100');
    expect(result.actionable).toBe(true);
  });

  it('returns zero when stream is inactive', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
    });

    vi.setSystemTime(100_000);

    const result = service.getClaimableAmount({
      ...makeStreamState({
        streamId: 3n,
        withdrawnAmount: '100',
        isActive: false,
      }),
    });

    expect(result.claimableAmount).toBe('0');
    expect(result.actionable).toBe(false);
  });

  it('returns zero when withdrawn exceeds deposited (non-actionable)', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
      nowMs: () => 100_000,
    });

    const result = service.getClaimableAmount({
      ...makeStreamState({
        streamId: 4n,
        withdrawnAmount: '150',
      }),
    });

    expect(result.claimableAmount).toBe('0');
    expect(result.actionable).toBe(false);
  });

  it('uses cache for repeated request with same stream state + timestamp', () => {
    vi.setSystemTime(5_000);
    const service = new ClaimableAmountService({
      cacheTtlMs: 10_000,
    });

    const input = makeStreamState({
      streamId: 5n,
      ratePerSecond: '7',
      depositedAmount: '700',
    });

    const first = service.getClaimableAmount(input, 5);
    const second = service.getClaimableAmount(input, 5);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);

    // Advance local clock beyond cache TTL
    vi.advanceTimersByTime(20_001);
    const third = service.getClaimableAmount(input, 5);
    expect(third.cached).toBe(false);
  });

  it('buckets the cache-key timestamp so requests within the same 5s window share an entry (Issue #1249)', () => {
    vi.setSystemTime(5_000);
    const service = new ClaimableAmountService({
      cacheTtlMs: 60_000,
    });

    const input = makeStreamState({
      streamId: 8n,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '0',
    });

    // Second 5 and second 9 land in the same 5s bucket (5..9), so the second
    // request must reuse the cached value instead of creating a new key.
    const first = service.getClaimableAmount(input, 5);
    expect(first.cached).toBe(false);
    expect(first.calculatedAt).toBe(5);
    expect(first.claimableAmount).toBe('50'); // 5s elapsed × 10/s

    const sameBucket = service.getClaimableAmount(input, 9);
    expect(sameBucket.cached).toBe(true);
    // The cached payload reflects the second the value was computed at.
    expect(sameBucket.calculatedAt).toBe(5);
    expect(sameBucket.claimableAmount).toBe('50');

    // Second 10 starts a new bucket, so a fresh calculation is performed
    // (and the value reflects the extra elapsed second).
    const nextBucket = service.getClaimableAmount(input, 10);
    expect(nextBucket.cached).toBe(false);
    expect(nextBucket.calculatedAt).toBe(10);
    expect(nextBucket.claimableAmount).toBe('100'); // 10s elapsed × 10/s
  });

  it('reflects an indexed withdrawal immediately, without waiting for the cache TTL', () => {
    // The cache key is derived from getStateFingerprint(), which folds in
    // withdrawnAmount and lastUpdateTime (see claimable.service.ts). When the
    // indexer processes a TokensWithdrawn event it updates those fields on the
    // Stream row, so the *next* read (which is always given the freshly
    // reloaded stream from the DB, see stream.controller.ts / withdraw.ts)
    // naturally lands on a different cache key and can never return the
    // pre-withdrawal cached value — invalidation falls out of the key design
    // rather than needing an explicit "on withdrawal, delete this key" hook.
    vi.setSystemTime(50_000);
    const service = new ClaimableAmountService({
      cacheTtlMs: 60_000, // deliberately long TTL to prove this isn't just a TTL expiry
    });

    const preWithdrawalState = makeStreamState({
      streamId: 7n,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '0',
      lastUpdateTime: 0,
    });

    // Prime the cache with the pre-withdrawal state.
    const primed = service.getClaimableAmount(preWithdrawalState, 40);
    expect(primed.cached).toBe(false);
    expect(primed.claimableAmount).toBe('400'); // 40s * 10/s

    // A repeated read with the identical state still hits the cache.
    const repeated = service.getClaimableAmount(preWithdrawalState, 40);
    expect(repeated.cached).toBe(true);

    // Simulate the indexer processing a TokensWithdrawn event: withdrawnAmount
    // and lastUpdateTime are advanced on the stream row, exactly as
    // handleTokensWithdrawn does in soroban-event-worker.ts.
    const postWithdrawalState = makeStreamState({
      streamId: 7n,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '400',
      lastUpdateTime: 40,
    });

    // Well within the 60s TTL, so this only passes if the state change (not
    // TTL expiry) is what causes the fresh calculation.
    vi.advanceTimersByTime(1_000);
    const afterWithdrawal = service.getClaimableAmount(postWithdrawalState, 40);

    expect(afterWithdrawal.cached).toBe(false);
    expect(afterWithdrawal.claimableAmount).toBe('0'); // fully withdrawn as of lastUpdateTime=40
  });

  it('caps multiplication overflow at the remaining balance', () => {
    const i128Max = ((1n << 127n) - 1n).toString();
    vi.setSystemTime(1_000_000);
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
    });

    const result = service.getClaimableAmount({
      ...makeStreamState({
        streamId: 6n,
        ratePerSecond: i128Max,
        depositedAmount: i128Max,
        withdrawnAmount: '42',
      }),
    }, 1000); // 1000 seconds elapsed

    expect(result.claimableAmount).toBe(((1n << 127n) - 1n - 42n).toString());
  });

  it('fuzzes claimable invariants for random amounts, durations, and pauses', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 0,
    });
    let seed = 0x4f1bbcdcn;

    const next = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed;
    };

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const deposited = 1n + (next() % 1_000_000_000_000n);
      const withdrawn = next() % (deposited + 1n);
      const duration = 1n + (next() % 1_000_000n);
      const elapsed = next() % (duration * 4n);
      const rate =
        iteration % 97 === 0
          ? (1n << 127n) - 1n
          : 1n + (deposited / duration) + (next() % 100_000n);
      const pauseStart = next() % (elapsed + 1n);
      const paused = (next() & 1n) === 1n;
      const now = Number(elapsed);
      const remaining = deposited - withdrawn;

      const result = service.getClaimableAmount({
        ...makeStreamState({
          streamId: BigInt(10_000 + iteration),
          ratePerSecond: rate.toString(),
          depositedAmount: deposited.toString(),
          withdrawnAmount: withdrawn.toString(),
          lastUpdateTime: 0,
          isPaused: paused,
          pausedAt: paused ? Number(pauseStart) : null,
          totalPausedDuration: paused ? Number(elapsed - pauseStart) : 0,
        }),
      }, now);

      const claimable = BigInt(result.claimableAmount);
      const cancelRefund = deposited - withdrawn - claimable;

      expect(withdrawn <= deposited, `iteration ${iteration}: withdrawn exceeded deposited`).toBe(true);
      expect(claimable <= remaining, `iteration ${iteration}: claimable exceeded remaining`).toBe(true);
      expect(cancelRefund + withdrawn + claimable <= deposited, `iteration ${iteration}: cancel settlement exceeded deposit`).toBe(true);
    }
  });

  it('maintains independent cache entries for same streamId across different tokens', () => {
    vi.setSystemTime(5_000);
    const service = new ClaimableAmountService({
      cacheTtlMs: 10_000,
    });

    // Two streams with the same numeric ID but different token contracts
    const streamTokenA = makeStreamState({
      streamId: 42n,
      tokenAddress: 'TOKEN_A',
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '0',
    });

    const streamTokenB = makeStreamState({
      streamId: 42n,
      tokenAddress: 'TOKEN_B',
      ratePerSecond: '5',
      depositedAmount: '2000',
      withdrawnAmount: '500',
    });

    const resultA = service.getClaimableAmount(streamTokenA, 100);
    const resultB = service.getClaimableAmount(streamTokenB, 100);

    // Both should be cache misses (different token = different cache key)
    expect(resultA.cached).toBe(false);
    expect(resultB.cached).toBe(false);

    // The values should differ because the streams have different parameters
    expect(resultA.claimableAmount).not.toBe(resultB.claimableAmount);

    // Second call for Token A should be a cache hit
    const resultA2 = service.getClaimableAmount(streamTokenA, 100);
    expect(resultA2.cached).toBe(true);
    expect(resultA2.claimableAmount).toBe(resultA.claimableAmount);

    // Second call for Token B should also be a cache hit (independent of A)
    const resultB2 = service.getClaimableAmount(streamTokenB, 100);
    expect(resultB2.cached).toBe(true);
    expect(resultB2.claimableAmount).toBe(resultB.claimableAmount);
  });
});

describe('calculateHistoricalStreamSnapshot', () => {
  const stream = { streamId: 42n, ratePerSecond: '2', startTime: 100 };
  const event = (eventType: string, timestamp: number, amount: string | null = null, metadata: Record<string, unknown> = {}, ledgerSequence = timestamp) => ({
    eventType, timestamp, amount, metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null, ledgerSequence,
  });

  it('replays creation, top-ups, withdrawals, and a completed pause interval', () => {
    const snapshot = calculateHistoricalStreamSnapshot(stream, [
      event('CREATED', 100, '500'),
      event('TOPPED_UP', 200, '200', { newDepositedAmount: '700' }),
      event('WITHDRAWN', 220, '150'),
      event('PAUSED', 250, null, { pausedAt: '250' }),
      event('RESUMED', 300, null, { pausedDuration: 50 }),
    ], 350);

    expect(snapshot).toEqual({
      streamId: '42', timestamp: 350, depositedAmount: '700', withdrawnAmount: '150',
      claimableAmount: '250', unvestedAmount: '300', statusAtTimestamp: 'ACTIVE',
    });
  });

  it('freezes accrual while paused at the requested timestamp', () => {
    const snapshot = calculateHistoricalStreamSnapshot(stream, [
      event('CREATED', 100, '1000'),
      event('WITHDRAWN', 120, '50'),
      event('PAUSED', 200, null, { pausedAt: '200' }),
    ], 260);

    expect(snapshot.claimableAmount).toBe('150');
    expect(snapshot.unvestedAmount).toBe('800');
    expect(snapshot.statusAtTimestamp).toBe('PAUSED');
  });

  it('replays cancellation as a terminal state and preserves its cumulative withdrawn amount', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      { ...stream, ratePerSecond: '1' },
      [
        event('CREATED', 100, '1000'),
        event('WITHDRAWN', 120, '25'),
        event('CANCELLED', 150, '950', { amountWithdrawn: '50', refundedAmount: '950' }),
      ],
      300,
    );

    expect(snapshot).toEqual({
      streamId: '42', timestamp: 300, depositedAmount: '1000', withdrawnAmount: '50',
      claimableAmount: '0', unvestedAmount: '950', statusAtTimestamp: 'CANCELLED',
    });
  });

  it('matches the live claimable calculation for a static active stream checkpoint', () => {
    const timestamp = 150;
    const snapshot = calculateHistoricalStreamSnapshot(
      { streamId: 42n, ratePerSecond: '10', startTime: 100 },
      [event('CREATED', 100, '1000')],
      timestamp,
    );
    const simulatedClaimable = new ClaimableAmountService({ cacheTtlMs: 0 }).getClaimableAmount(
      makeStreamState({ streamId: 42n, ratePerSecond: '10', depositedAmount: '1000', lastUpdateTime: 100 }),
      timestamp,
    );

    expect(snapshot.claimableAmount).toBe(simulatedClaimable.claimableAmount);
  });
  it('caps completed vesting at the total deposit and honors cumulative withdrawals', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      { ...stream, ratePerSecond: '10' },
      [event('CREATED', 100, '500'), event('COMPLETED', 200, '500')],
      400,
    );
    expect(snapshot.claimableAmount).toBe('0');
    expect(snapshot.unvestedAmount).toBe('0');
    expect(snapshot.statusAtTimestamp).toBe('COMPLETED');
  });

  it('returns an empty not-started snapshot before the stream start', () => {
    expect(calculateHistoricalStreamSnapshot(stream, [], 99)).toEqual({
      streamId: '42', timestamp: 99, depositedAmount: '0', withdrawnAmount: '0',
      claimableAmount: '0', unvestedAmount: '0', statusAtTimestamp: 'NOT_STARTED',
    });
  });

  it('rejects snapshots when the creation event is missing', () => {
    expect(() => calculateHistoricalStreamSnapshot(stream, [], 100)).toThrow(/creation event is missing/);
  });
});
