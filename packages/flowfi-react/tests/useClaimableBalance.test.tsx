import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useClaimableBalance } from '../src/hooks/useClaimableBalance';
import { ClaimableTicker } from '../src/components/ClaimableTicker';
import { computeClaimable } from '../src/utils/math';
import type { FlowFiStream } from '../src/types';

// Freeze time for the entire suite so stream windows stay relative to "now".
const NOW = Date.parse('2025-06-15T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);

function makeStream(overrides: Partial<FlowFiStream> = {}): FlowFiStream {
  return {
    id: 'stream-1',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: { symbol: 'USDC', address: '0xusdc', decimals: 6 },
    depositedAmount: '1000000000',
    withdrawnAmount: '0',
    remainingBalance: '1000000000',
    claimableBalance: '0',
    startTimestamp: NOW_SECONDS - 500,
    endTimestamp: NOW_SECONDS + 500,
    cliffTimestamp: 0,
    status: 'active',
    usdRate: 1,
    ...overrides,
  };
}

describe('computeClaimable', () => {
  it('returns 0 before the cliff', () => {
    const stream = makeStream({ cliffTimestamp: NOW_SECONDS + 100 });
    expect(computeClaimable(stream, NOW)).toBe(0);
  });

  it('returns half of deposited at the midpoint', () => {
    expect(computeClaimable(makeStream(), NOW)).toBeCloseTo(500, 1);
  });

  it('returns full deposited after end', () => {
    expect(computeClaimable(makeStream(), (NOW_SECONDS + 2000) * 1000)).toBeCloseTo(1000, 1);
  });

  it('subtracts already-withdrawn amount', () => {
    const stream = makeStream({ withdrawnAmount: '200000000' });
    expect(computeClaimable(stream, NOW)).toBeCloseTo(300, 1);
  });

  it('returns 0 for cancelled streams', () => {
    expect(computeClaimable(makeStream({ status: 'cancelled' }), NOW)).toBe(0);
  });

  it('handles zero-duration streams without dividing by zero', () => {
    const stream = makeStream({ startTimestamp: NOW_SECONDS, endTimestamp: NOW_SECONDS });
    expect(computeClaimable(stream, NOW)).toBeCloseTo(1000, 1);
  });
});

function Probe({ stream }: { stream: FlowFiStream }) {
  const { claimable } = useClaimableBalance(stream, { intervalMs: 16 });
  return <span data-testid="probe">{claimable.toFixed(2)}</span>;
}

describe('useClaimableBalance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an initial value synchronously', () => {
    render(<Probe stream={makeStream()} />);
    expect(screen.getByTestId('probe')).toHaveTextContent('500.00');
  });

  it('updates as time advances', async () => {
    render(<Probe stream={makeStream()} />);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    const value = Number(screen.getByTestId('probe').textContent ?? '0');
    expect(value).toBeGreaterThanOrEqual(500);
    expect(value).toBeLessThanOrEqual(1000);
  });
});

describe('ClaimableTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a formatted token amount', () => {
    render(<ClaimableTicker stream={makeStream()} animated={false} />);
    const text = screen.getByTestId('claimable-ticker').textContent ?? '';
    expect(text).toMatch(/500/);
    expect(text).toMatch(/USDC/);
  });

  it('renders USD when format="usd"', () => {
    render(<ClaimableTicker stream={makeStream()} format="usd" animated={false} />);
    expect(screen.getByTestId('claimable-ticker').textContent).toMatch(/\$500/);
  });

  it('renders 0 for null streams', () => {
    render(<ClaimableTicker stream={null} animated={false} />);
    expect(screen.getByTestId('claimable-ticker').textContent).toMatch(/0/);
  });
});
