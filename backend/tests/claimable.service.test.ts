import { describe, expect, it } from 'vitest';
import { ClaimableAmountService } from '../src/services/claimable.service.js';

describe('ClaimableAmountService', () => {
  it('calculates claimable amount for active stream', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
      nowMs: () => 10_000,
    });

    const result = service.getClaimableAmount({
      streamId: 1,
      ratePerSecond: '5',
      depositedAmount: '500',
      withdrawnAmount: '100',
      lastUpdateTime: 7,
      isActive: true,
    });

    // elapsed = 10 - 7 = 3
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
      nowMs: () => 100_000,
    });

    const result = service.getClaimableAmount({
      streamId: 2,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '900',
      lastUpdateTime: 0,
      isActive: true,
    });

    expect(result.claimableAmount).toBe('100');
    expect(result.actionable).toBe(true);
  });

  it('returns zero when stream is inactive', () => {
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
      nowMs: () => 100_000,
    });

    const result = service.getClaimableAmount({
      streamId: 3,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      lastUpdateTime: 0,
      isActive: false,
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
      streamId: 4,
      ratePerSecond: '10',
      depositedAmount: '100',
      withdrawnAmount: '150',
      lastUpdateTime: 0,
      isActive: true,
    });

    expect(result.claimableAmount).toBe('0');
    expect(result.actionable).toBe(false);
  });

  it('uses cache for repeated request with same stream state + timestamp', () => {
    let now = 5_000;
    const service = new ClaimableAmountService({
      cacheTtlMs: 10_000,
      nowMs: () => now,
    });

    const input = {
      streamId: 5,
      ratePerSecond: '7',
      depositedAmount: '700',
      withdrawnAmount: '0',
      lastUpdateTime: 0,
      isActive: true,
    };

    const first = service.getClaimableAmount(input, 5);
    const second = service.getClaimableAmount(input, 5);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);

    // Advance local clock beyond cache TTL
    now = 20_001;
    const third = service.getClaimableAmount(input, 5);
    expect(third.cached).toBe(false);
  });

  it('saturates overflow-safe multiplication to i128 max', () => {
    const i128Max = ((1n << 127n) - 1n).toString();
    const service = new ClaimableAmountService({
      cacheTtlMs: 5_000,
      nowMs: () => 1_000,
    });

    const result = service.getClaimableAmount({
      streamId: 6,
      ratePerSecond: i128Max,
      depositedAmount: i128Max,
      withdrawnAmount: '0',
      lastUpdateTime: 998,
      isActive: true,
    });

    // elapsed=2 => streamed overflows i128, saturates to i128 max
    // remaining=i128 max => claimable=i128 max
    expect(result.claimableAmount).toBe(i128Max);
    expect(result.actionable).toBe(true);
  });
});

