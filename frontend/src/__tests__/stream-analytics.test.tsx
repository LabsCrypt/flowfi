import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Stream } from '@/types/analytics';
import { DEFAULT_FILTERS, applyFilters } from '@/utils/analytics-filters';
import {
  ACCOUNTING_COLUMNS,
  buildAccountingRows,
  buildExport,
  toCsv,
} from '@/utils/export-accounting';
import { StreamAnalyticsView } from '@/components/analytics/StreamAnalyticsView';

const NOW = Date.parse('2025-01-15T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 'stream-1',
    createdAt: '2025-01-10T00:00:00Z',
    sender: '0xSender000000000000000000000000000000000000',
    recipient: '0xRecipient000000000000000000000000000000000',
    token: { symbol: 'USDC', address: '0xusdc', decimals: 6 },
    depositedAmount: '1000000000', // 1000 USDC
    withdrawnAmount: '250000000',
    remainingBalance: '750000000',
    claimableBalance: '50000000',
    startTimestamp: NOW_SECONDS - 86_400 * 10,
    endTimestamp: NOW_SECONDS + 86_400 * 20,
    cliffTimestamp: 0,
    status: 'active',
    lastActionLedger: 12345,
    usdRate: 1,
    ...overrides,
  };
}

describe('applyFilters', () => {
  it('filters by token symbol', () => {
    const streams = [
      makeStream(),
      makeStream({
        id: 'stream-2',
        token: { symbol: 'DAI', address: '0xdai', decimals: 18 },
      }),
    ];

    const result = applyFilters(streams, { ...DEFAULT_FILTERS, tokens: ['USDC'] }, { now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]?.token.symbol).toBe('USDC');
  });

  it('filters by status', () => {
    const streams = [
      makeStream(),
      makeStream({ id: 'stream-2', status: 'paused' }),
      makeStream({ id: 'stream-3', status: 'completed' }),
    ];

    const result = applyFilters(
      streams,
      { ...DEFAULT_FILTERS, statuses: ['paused'] },
      { now: NOW },
    );
    expect(result.map((s) => s.id)).toEqual(['stream-2']);
  });

  it('filters by full-text search across memo and address', () => {
    const streams = [
      makeStream({ id: 'stream-1', memo: 'payroll Q1' }),
      makeStream({
        id: 'stream-2',
        recipient: '0xalice000000000000000000000000000000000000',
      }),
    ];

    expect(
      applyFilters(streams, { ...DEFAULT_FILTERS, search: 'payroll' }, { now: NOW }),
    ).toHaveLength(1);
    expect(
      applyFilters(streams, { ...DEFAULT_FILTERS, search: 'alice' }, { now: NOW }),
    ).toHaveLength(1);
  });

  it('filters by low_runway pseudo-status', () => {
    const nearEnd = makeStream({
      id: 'low-runway',
      remainingBalance: '10000000',
      startTimestamp: NOW_SECONDS - 86_400 * 25,
      endTimestamp: NOW_SECONDS + 86_400 * 30,
    });
    const healthy = makeStream({ id: 'healthy' });

    const result = applyFilters(
      [nearEnd, healthy],
      { ...DEFAULT_FILTERS, statuses: ['low_runway'] },
      { now: NOW },
    );

    expect(result.map((s) => s.id)).toEqual(['low-runway']);
  });

  it('filters by date range (30d)', () => {
    const streams = [
      makeStream({ id: 'recent', createdAt: '2025-01-12T00:00:00Z' }),
      makeStream({ id: 'old', createdAt: '2024-01-01T00:00:00Z' }),
    ];

    const result = applyFilters(
      streams,
      { ...DEFAULT_FILTERS, dateRange: '30d' },
      { now: NOW },
    );
    expect(result.map((s) => s.id)).toEqual(['recent']);
  });

  it('combines multiple filters simultaneously', () => {
    const streams = [
      makeStream({ id: 'match', memo: 'payroll' }),
      makeStream({ id: 'wrong-token', memo: 'payroll', token: { symbol: 'DAI', address: '0xdai', decimals: 18 } }),
      makeStream({ id: 'wrong-status', memo: 'payroll', status: 'paused' }),
    ];

    const result = applyFilters(
      streams,
      {
        ...DEFAULT_FILTERS,
        tokens: ['USDC'],
        statuses: ['active'],
        search: 'payroll',
      },
      { now: NOW },
    );

    expect(result.map((s) => s.id)).toEqual(['match']);
  });

  it('filters by wallet role when connected', () => {
    const streams = [
      makeStream({ id: 'as-sender' }),
      makeStream({ id: 'as-recipient', sender: '0xOther', recipient: '0xME' }),
    ];

    const result = applyFilters(
      streams,
      { ...DEFAULT_FILTERS, role: 'sender' },
      { now: NOW, walletAddress: '0xSender000000000000000000000000000000000000' },
    );

    expect(result.map((s) => s.id)).toEqual(['as-sender']);
  });
});

describe('CSV export / accounting format', () => {
  it('emits the required accounting headers', () => {
    const csv = toCsv(buildAccountingRows([makeStream()]), ACCOUNTING_COLUMNS, { bom: false });
    const [header] = csv.split('\n');

    expect(header).toContain('Stream ID');
    expect(header).toContain('Creation Date');
    expect(header).toContain('Sender Address');
    expect(header).toContain('Recipient Address');
    expect(header).toContain('Token Symbol');
    expect(header).toContain('Token Contract Address');
    expect(header).toContain('Deposited Amount');
    expect(header).toContain('Withdrawn Amount');
    expect(header).toContain('Remaining Balance');
    expect(header).toContain('Claimable Balance');
    expect(header).toContain('Start Timestamp');
    expect(header).toContain('End Timestamp');
    expect(header).toContain('Cliff Timestamp');
    expect(header).toContain('Status');
    expect(header).toContain('Last Action Ledger');
  });

  it('writes exact decimal amounts (no precision loss)', () => {
    const csv = toCsv(buildAccountingRows([makeStream()]), ACCOUNTING_COLUMNS, { bom: false });
    expect(csv).toContain('1000');
    expect(csv).toContain('250');
    expect(csv).toContain('750');
    expect(csv).toContain('50');
  });

  it('quotes values containing commas', () => {
    const csv = toCsv(
      [{ a: 'hello, world' }],
      [{ key: 'a', header: 'A' }],
      { bom: false },
    );
    expect(csv).toContain('"hello, world"');
  });

  it('builds a QuickBooks CSV with journal columns', () => {
    const bundle = buildExport([makeStream()], 'quickbooks', {
      generatedAt: new Date('2025-01-15T00:00:00Z'),
    });
    expect(bundle.filename).toMatch(/quickbooks.*\.csv$/);
    expect(bundle.content).toContain('Journal No.');
    expect(bundle.content).toContain('Debit');
    expect(bundle.content).toContain('Credit');
    expect(bundle.content).toContain('Crypto Assets:USDC');
  });

  it('builds a JSON export with stream metadata', () => {
    const bundle = buildExport([makeStream()], 'json');
    const parsed = JSON.parse(bundle.content);
    expect(parsed.streamCount).toBe(1);
    expect(parsed.streams[0].tokenSymbol).toBe('USDC');
    expect(bundle.mimeType).toContain('application/json');
  });
});

describe('StreamAnalyticsView', () => {
  it('renders the zero state when no streams are available', () => {
    render(
      <StreamAnalyticsView
        streams={[]}
        filters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        onResetFilters={() => {}}
      />,
    );

    expect(screen.getByTestId('zero-state')).toBeInTheDocument();
    expect(screen.getByText(/No streams match your filters/i)).toBeInTheDocument();
  });

  it('renders the KPI ribbon with computed values', () => {
    render(
      <StreamAnalyticsView
        streams={[makeStream()]}
        filters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        onResetFilters={() => {}}
      />,
    );

    expect(screen.getByTestId('kpi-ribbon')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-tvs')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-outflow')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-active')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-runway')).toBeInTheDocument();
  });

  it('disables export buttons when the filtered list is empty', () => {
    render(
      <StreamAnalyticsView
        streams={[]}
        filters={DEFAULT_FILTERS}
        onFiltersChange={() => {}}
        onResetFilters={() => {}}
      />,
    );

    expect(screen.getByTestId('export-csv')).toBeDisabled();
    expect(screen.getByTestId('export-json')).toBeDisabled();
    expect(screen.getByTestId('export-quickbooks')).toBeDisabled();
  });

  it('emits filter patches from the toolbar', () => {
    const onChange = vi.fn();
    render(
      <StreamAnalyticsView
        streams={[makeStream()]}
        filters={DEFAULT_FILTERS}
        onFiltersChange={onChange}
        onResetFilters={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('filter-date-range'), {
      target: { value: '7d' },
    });

    expect(onChange).toHaveBeenCalledWith({ dateRange: '7d' });
  });
});
