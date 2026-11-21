import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ClaimableAmountService,
  calculateHistoricalStreamSnapshot,
  StreamSnapshotHistoryError,
} from '../src/services/claimable.service.js';
import { cache } from '../src/lib/redis.js';
import type {
  ClaimableStreamState,
  HistoricalSnapshotEvent,
  HistoricalSnapshotStream,
} from '../src/services/claimable.service.js';

const I128_MAX = (1n << 127n) - 1n;

/**
 * The accrual clock in `getClaimableAmount` is anchored on `lastUpdateTime` and
 * the cache key is bucketed to 5s windows, so every case here passes an explicit
 * `requestedAt` and its own `streamId` — otherwise two boundary samples in the
 * same bucket would read back the first entry instead of recomputing.
 */
function streamState(overrides: Record<string, unknown> = {}): ClaimableStreamState {
  return {
    streamId: 900n,
    tokenAddress: 'TOKEN_BOUNDARY',
    ratePerSecond: '10',
    depositedAmount: '1000',
    withdrawnAmount: '0',
    startTime: 0n,
    lastUpdateTime: 0,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    ...overrides,
  } as unknown as ClaimableStreamState;
}

function service(nowMsValue = 1_000): ClaimableAmountService {
  return new ClaimableAmountService({ cacheTtlMs: 5_000, nowMs: () => nowMsValue });
}

function snapshotStream(overrides: Record<string, unknown> = {}): HistoricalSnapshotStream {
  return { streamId: 4242n, ratePerSecond: '5', startTime: 0, ...overrides } as HistoricalSnapshotStream;
}

function snapshotEvent(overrides: Record<string, unknown> = {}): HistoricalSnapshotEvent {
  return { eventType: 'CREATED', amount: '1000', timestamp: 0, metadata: null, ...overrides } as HistoricalSnapshotEvent;
}

describe('ClaimableAmountService schedule boundaries (#1753)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats a timestamp earlier than lastUpdateTime as zero elapsed', () => {
    const result = service().getClaimableAmount(streamState({ lastUpdateTime: 200 }), 100);

    expect(result.claimableAmount).toBe('0');
    expect(result.actionable).toBe(false);
    expect(result.calculatedAt).toBe(100);
    expect(result.cached).toBe(false);
  });

  it('accrues the first second after lastUpdateTime', () => {
    const result = service().getClaimableAmount(streamState({ lastUpdateTime: 100 }), 101);

    expect(result.claimableAmount).toBe('10');
    expect(result.actionable).toBe(true);
  });

  it('freezes accrual from the second after pausedAt', () => {
    const paused = { isPaused: true, pausedAt: 100 };

    // One second before the pause: the whole window still accrues.
    expect(service().getClaimableAmount(streamState({ streamId: 901n, ...paused }), 99)).toMatchObject({
      claimableAmount: '990',
      actionable: true,
    });
    // At pausedAt the pause has not started yet, so nothing is deducted.
    expect(service().getClaimableAmount(streamState({ streamId: 902n, ...paused }), 100)).toMatchObject({
      claimableAmount: '1000',
    });
    // One second later the pause interval is removed from elapsed, so accrual stops.
    expect(service().getClaimableAmount(streamState({ streamId: 903n, ...paused }), 101)).toMatchObject({
      claimableAmount: '1000',
    });
  });

  it('floors elapsed at zero when the pause window covers the whole interval', () => {
    const result = service().getClaimableAmount(
      streamState({ streamId: 904n, isPaused: true, pausedAt: 50, lastUpdateTime: 50 }),
      100,
    );

    expect(result.claimableAmount).toBe('0');
    expect(result.actionable).toBe(false);
  });

  it('caps an out-of-range i128 rate instead of throwing and caps the result at remaining', () => {
    const result = service().getClaimableAmount(
      streamState({ streamId: 905n, ratePerSecond: (I128_MAX + 1n).toString() }),
      100,
    );

    expect(result.claimableAmount).toBe('1000');
    expect(result.actionable).toBe(true);
  });

  it.each([
    ['ratePerSecond', '1.5'],
    ['depositedAmount', 'abc'],
    ['withdrawnAmount', 'not-a-number'],
  ] as const)('rejects a non-integer %s with the i128 error contract', (field, value) => {
    const before = cache.getStats().itemCount;

    expect(() => service().getClaimableAmount(streamState({ streamId: 906n, [field]: value }), 100)).toThrow(
      `Invalid i128 value for '${field}'`,
    );

    // The rejection happens before the value is stored, so nothing is cached.
    expect(cache.getStats().itemCount).toBe(before);
  });

  it('keeps separate cache entries for states that differ only by updatedAt', () => {
    const svc = service();
    const first = streamState({ streamId: 907n, updatedAt: new Date(1000) });
    const second = streamState({ streamId: 907n, updatedAt: new Date(2000) });
    const before = cache.getStats().itemCount;

    expect(svc.getClaimableAmount(first, 100).cached).toBe(false);
    expect(svc.getClaimableAmount(second, 100).cached).toBe(false);
    expect(cache.getStats().itemCount).toBe(before + 2);
    expect(svc.getClaimableAmount(first, 100)).toMatchObject({ cached: true });
  });

  it('reports the entry creation time on a cache hit and recomputes at the TTL boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));

    const svc = new ClaimableAmountService({ cacheTtlMs: 5_000 });
    const state = streamState({ streamId: 908n });

    const cold = svc.getClaimableAmount(state, 1_000);
    expect(cold.cached).toBe(false);

    vi.setSystemTime(new Date(5_999));
    const hit = svc.getClaimableAmount(state, 1_000);
    expect(hit).toMatchObject({ cached: true, claimableAmount: cold.claimableAmount });
    expect(hit.cachedAt).toBe(new Date(1_000).toISOString());

    // expiresAt is compared with `>=`, so the 5s TTL ends at exactly 6000ms.
    vi.setSystemTime(new Date(6_000));
    expect(svc.getClaimableAmount(state, 1_000).cached).toBe(false);
  });

  it('surfaces a cache read failure instead of answering with an unverified number', () => {
    const unavailable = new Error('claimable cache unavailable');
    const setSpy = vi.spyOn(cache, 'set').mockImplementation(() => undefined);
    vi.spyOn(cache, 'get').mockImplementation(() => {
      throw unavailable;
    });

    expect(() => service().getClaimableAmount(streamState({ streamId: 909n }), 100)).toThrow(unavailable);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('calculateHistoricalStreamSnapshot boundaries (#1753)', () => {
  it('returns the exact startTime as started-but-unaccrued rather than NOT_STARTED', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream({ startTime: 100 }),
      [snapshotEvent({ timestamp: 100 })],
      100,
    );

    expect(snapshot).toMatchObject({
      statusAtTimestamp: 'ACTIVE',
      claimableAmount: '0',
      unvestedAmount: '1000',
      withdrawnAmount: '0',
    });
  });

  it('freezes accrual at the completion event even when the target is later', () => {
    const events = [snapshotEvent(), snapshotEvent({ eventType: 'COMPLETED', amount: '100', timestamp: 100 })];

    const atTerminal = calculateHistoricalStreamSnapshot(snapshotStream(), events, 100);
    const afterTerminal = calculateHistoricalStreamSnapshot(snapshotStream(), events, 200);

    expect(atTerminal).toMatchObject({ claimableAmount: '400', statusAtTimestamp: 'COMPLETED', withdrawnAmount: '100' });
    // Only the requested timestamp moves; every amount stays frozen at the terminal event.
    expect(afterTerminal).toMatchObject({
      timestamp: 200,
      depositedAmount: atTerminal.depositedAmount,
      withdrawnAmount: atTerminal.withdrawnAmount,
      claimableAmount: atTerminal.claimableAmount,
      unvestedAmount: atTerminal.unvestedAmount,
      statusAtTimestamp: atTerminal.statusAtTimestamp,
    });
  });

  it('excludes a closed pause interval from vesting', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream(),
      [
        snapshotEvent(),
        snapshotEvent({ eventType: 'PAUSED', amount: null, timestamp: 40, metadata: '{"pausedAt":40}' }),
        snapshotEvent({ eventType: 'RESUMED', amount: null, timestamp: 60, metadata: '{"pausedDuration":20}' }),
      ],
      100,
    );

    // 100s elapsed, 40-60s paused => 80s active at rate 5 => 400 claimable,
    // so the rest of the 1000 deposited is still unvested.
    expect(snapshot).toMatchObject({
      statusAtTimestamp: 'ACTIVE',
      claimableAmount: '400',
      unvestedAmount: '600',
    });
  });

  it('clamps an open pause to the accrual end', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream(),
      [snapshotEvent(), snapshotEvent({ eventType: 'PAUSED', amount: null, timestamp: 40, metadata: '{"pausedAt":40}' })],
      50,
    );

    expect(snapshot).toMatchObject({ statusAtTimestamp: 'PAUSED', claimableAmount: '200' });
  });

  it('ignores events recorded after the requested timestamp', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream(),
      [snapshotEvent(), snapshotEvent({ eventType: 'WITHDRAWN', amount: '200', timestamp: 300 })],
      100,
    );

    expect(snapshot).toMatchObject({ withdrawnAmount: '0', claimableAmount: '500', statusAtTimestamp: 'ACTIVE' });
  });

  it('orders same-timestamp events by ledger sequence, not array position', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream(),
      [
        snapshotEvent(),
        snapshotEvent({ eventType: 'WITHDRAWN', amount: '200', timestamp: 100, ledgerSequence: 2 }),
        snapshotEvent({ eventType: 'COMPLETED', amount: '100', timestamp: 100, ledgerSequence: 1 }),
      ],
      100,
    );

    // COMPLETED (seq 1) applies first, then the withdrawal is added on top.
    expect(snapshot).toMatchObject({ withdrawnAmount: '300', claimableAmount: '200', statusAtTimestamp: 'COMPLETED' });
  });

  it('prefers the cumulative newDepositedAmount metadata over the top-up delta', () => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream(),
      [snapshotEvent(), snapshotEvent({ eventType: 'TOPPED_UP', amount: '200', timestamp: 50, metadata: '{"newDepositedAmount":1500}' })],
      100,
    );

    expect(snapshot).toMatchObject({ depositedAmount: '1500', claimableAmount: '500', unvestedAmount: '1000' });
  });

  it.each([
    ['refund fallback', '{"refundedAmount":200}', '800'],
    ['cumulative amountWithdrawn', '{"amountWithdrawn":300}', '300'],
  ] as const)('replays cancellation through the %s field', (_label, metadata, expectedWithdrawn) => {
    const snapshot = calculateHistoricalStreamSnapshot(
      snapshotStream(),
      [snapshotEvent(), snapshotEvent({ eventType: 'CANCELLED', amount: '200', timestamp: 100, metadata })],
      100,
    );

    expect(snapshot).toMatchObject({ statusAtTimestamp: 'CANCELLED', withdrawnAmount: expectedWithdrawn });
  });

  it.each([
    [
      'a stream with no startTime',
      snapshotStream({ startTime: null }),
      [snapshotEvent()],
      'Missing startTime in stream history',
    ],
    [
      'a stream with an unparsable startTime',
      snapshotStream({ startTime: 'soon' }),
      [snapshotEvent()],
      'Invalid startTime in stream history',
    ],
    [
      'a creation event with no amount',
      snapshotStream(),
      [snapshotEvent({ amount: null })],
      'Missing creation deposit in stream history',
    ],
    [
      'an event with an unparsable timestamp',
      snapshotStream(),
      [snapshotEvent({ timestamp: 'yesterday' })],
      'Invalid event timestamp in stream history',
    ],
    [
      'a top-up with neither metadata nor amount',
      snapshotStream(),
      [snapshotEvent(), snapshotEvent({ eventType: 'TOPPED_UP', amount: null, timestamp: 50 })],
      'Missing top-up amount in stream history',
    ],
    [
      'a top-up whose metadata is not JSON',
      snapshotStream(),
      [snapshotEvent(), snapshotEvent({ eventType: 'TOPPED_UP', amount: '200', timestamp: 50, metadata: 'oops' })],
      'Invalid metadata for TOPPED_UP event',
    ],
    [
      'a replay with no creation event',
      snapshotStream(),
      [snapshotEvent({ eventType: 'WITHDRAWN', amount: '10', timestamp: 10 })],
      'Stream creation event is missing; historical balance cannot be reconstructed',
    ],
  ] as Array<[string, HistoricalSnapshotStream, HistoricalSnapshotEvent[], string]>)('rejects %s with the history error contract', (_label, stream, events, message) => {
    expect(() => calculateHistoricalStreamSnapshot(stream, events, 100)).toThrow(StreamSnapshotHistoryError);
    expect(() => calculateHistoricalStreamSnapshot(stream, events, 100)).toThrow(message);
  });

  it.each(['0', '-5'])('rejects a non-positive ratePerSecond (%s)', (rate) => {
    expect(() => calculateHistoricalStreamSnapshot(snapshotStream({ ratePerSecond: rate }), [snapshotEvent()], 100)).toThrow(
      'ratePerSecond must be positive',
    );
  });
});
