import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Stream } from '@/types/analytics';
import { DEFAULT_FILTERS, applyFilters } from '@/utils/analytics-filters';
import {
  ACCOUNTING_COLUMNS,
  buildAccountingRows,
  buildExport,
  toCsv,
} from '@/utils/export-accounting';
import { StreamAnalyticsView } from '@/components/analytics/StreamAnalyticsView';
import {
  normalizeStream,
  normalizeStreams,
  getDefaultStreamsEndpoint,
} from '@/hooks/useStreams';
import { TOKEN_ADDRESSES } from '@/lib/soroban';
import AnalyticsPage from '@/app/analytics/page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

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

describe('normalizeStream and normalizeStreams (Issue #1709)', () => {
  it('prefers on-chain streamId over database UUID id without silently substituting UUID', () => {
    const restStream = {
      id: 'a8f7c9e0-1234-5678-9abc-def012345678',
      streamId: '42',
      sender: 'GSENDER1111111111111111111111111111111111111111111111111111',
      recipient: 'GRECIPIENT1111111111111111111111111111111111111111111111111',
      tokenAddress: TOKEN_ADDRESSES.USDC,
      depositedAmount: '10000000',
      withdrawnAmount: '2000000',
      startTime: 1710000000,
      endTime: 1710086400,
      isActive: true,
      isPaused: false,
    };

    const normalized = normalizeStream(restStream);
    expect(normalized).not.toBeNull();
    expect(normalized?.id).toBe('42');
    expect(normalized?.id).not.toBe('a8f7c9e0-1234-5678-9abc-def012345678');
  });

  it('supports numeric streamId and snake_case stream_id', () => {
    const streamNumeric = normalizeStream({
      id: 'db-uuid-1',
      streamId: 77,
      tokenAddress: TOKEN_ADDRESSES.XLM,
    });
    expect(streamNumeric?.id).toBe('77');

    const streamSnake = normalizeStream({
      id: 'db-uuid-2',
      stream_id: '99',
      tokenAddress: TOKEN_ADDRESSES.EURC,
    });
    expect(streamSnake?.id).toBe('99');
  });

  it('maps REST startTime and endTime to timestamps without zero dates', () => {
    const restStream = {
      id: 'uuid-1',
      streamId: '10',
      startTime: 1700000000,
      endTime: 1700086400,
      tokenAddress: TOKEN_ADDRESSES.USDC,
    };

    const normalized = normalizeStream(restStream);
    expect(normalized?.startTimestamp).toBe(1700000000);
    expect(normalized?.endTimestamp).toBe(1700086400);
    expect(normalized?.createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('maps REST state flags isActive and isPaused correctly across all states', () => {
    // 1. Paused stream
    const paused = normalizeStream({
      id: '1',
      streamId: '1',
      isActive: true,
      isPaused: true,
      tokenAddress: TOKEN_ADDRESSES.USDC,
    });
    expect(paused?.status).toBe('paused');

    // 2. Active stream
    const active = normalizeStream({
      id: '2',
      streamId: '2',
      isActive: true,
      isPaused: false,
      tokenAddress: TOKEN_ADDRESSES.USDC,
    });
    expect(active?.status).toBe('active');

    // 3. Completed stream (inactive, no CANCELLED event)
    const completed = normalizeStream({
      id: '3',
      streamId: '3',
      isActive: false,
      isPaused: false,
      tokenAddress: TOKEN_ADDRESSES.USDC,
      events: [{ eventType: 'COMPLETED' }],
    });
    expect(completed?.status).toBe('completed');

    // 4. Cancelled stream (inactive, with CANCELLED event)
    const cancelled = normalizeStream({
      id: '4',
      streamId: '4',
      isActive: false,
      isPaused: false,
      tokenAddress: TOKEN_ADDRESSES.USDC,
      events: [{ eventType: 'CANCELLED' }],
    });
    expect(cancelled?.status).toBe('cancelled');
  });

  it('resolves token symbol and scales with 7 decimals instead of silently substituting 18', () => {
    const usdcStream = normalizeStream({
      id: '1',
      streamId: '1',
      tokenAddress: TOKEN_ADDRESSES.USDC,
      depositedAmount: '70000000',
    });
    expect(usdcStream?.token.symbol).toBe('USDC');
    expect(usdcStream?.token.decimals).toBe(7);
    expect(usdcStream?.token.decimals).not.toBe(18);

    const xlmStream = normalizeStream({
      id: '2',
      streamId: '2',
      tokenAddress: TOKEN_ADDRESSES.XLM,
    });
    expect(xlmStream?.token.symbol).toBe('XLM');
    expect(xlmStream?.token.decimals).toBe(7);

    // Unknown contract address defaults to 7 (Stellar standard scale), never 18
    const unknownStream = normalizeStream({
      id: '3',
      streamId: '3',
      tokenAddress: 'CCUSTOMTOKENADDRESS1234567890',
    });
    expect(unknownStream?.token.decimals).toBe(7);
    expect(unknownStream?.token.decimals).not.toBe(18);

    // Explicit decimals in token record are preserved
    const explicitStream = normalizeStream({
      id: '4',
      streamId: '4',
      token: { symbol: 'DAI', address: '0xdai', decimals: 18 },
    });
    expect(explicitStream?.token.decimals).toBe(18);
  });

  it('calculates remainingBalance from depositedAmount and withdrawnAmount when omitted', () => {
    const stream = normalizeStream({
      id: '1',
      streamId: '1',
      tokenAddress: TOKEN_ADDRESSES.USDC,
      depositedAmount: '1000000000',
      withdrawnAmount: '250000000',
    });
    expect(stream?.remainingBalance).toBe('750000000');
  });

  it('normalizes wrapped array { data: [...] } and plain array [...] responses', () => {
    const record = { id: 'uuid-1', streamId: '1', tokenAddress: TOKEN_ADDRESSES.USDC };
    const fromWrapped = normalizeStreams({ data: [record] });
    expect(fromWrapped).toHaveLength(1);
    expect(fromWrapped[0]?.id).toBe('1');

    const fromArray = normalizeStreams([record]);
    expect(fromArray).toHaveLength(1);
    expect(fromArray[0]?.id).toBe('1');
  });
});

describe('getDefaultStreamsEndpoint', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns backend streams endpoint respecting configured NEXT_PUBLIC_API_URL', () => {
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001/v1';
    expect(getDefaultStreamsEndpoint()).toBe('http://localhost:3001/v1/streams');

    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001';
    expect(getDefaultStreamsEndpoint()).toBe('http://localhost:3001/v1/streams');

    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getDefaultStreamsEndpoint()).toBe('http://localhost:3001/v1/streams');
  });
});

describe('Mounted AnalyticsPage against backend responses (Issue #1709)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('mounts and renders active, paused, completed, and cancelled streams from backend response', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const backendData = {
      data: [
        {
          id: 'uuid-active-1',
          streamId: '101',
          sender: 'GSENDER1111111111111111111111111111111111111111111111111111',
          recipient: 'GRECIPIENT1111111111111111111111111111111111111111111111111',
          tokenAddress: TOKEN_ADDRESSES.USDC,
          depositedAmount: '1000000000',
          withdrawnAmount: '250000000',
          startTime: nowSeconds - 86400 * 5,
          endTime: nowSeconds + 86400 * 10,
          isActive: true,
          isPaused: false,
          createdAt: new Date((nowSeconds - 86400 * 5) * 1000).toISOString(),
        },
        {
          id: 'uuid-paused-2',
          streamId: '102',
          sender: 'GSENDER2222222222222222222222222222222222222222222222222222',
          recipient: 'GRECIPIENT2222222222222222222222222222222222222222222222222',
          tokenAddress: TOKEN_ADDRESSES.XLM,
          depositedAmount: '500000000',
          withdrawnAmount: '100000000',
          startTime: nowSeconds - 86400 * 3,
          endTime: nowSeconds + 86400 * 7,
          isActive: true,
          isPaused: true,
          createdAt: new Date((nowSeconds - 86400 * 3) * 1000).toISOString(),
        },
        {
          id: 'uuid-cancelled-3',
          streamId: '103',
          sender: 'GSENDER3333333333333333333333333333333333333333333333333333',
          recipient: 'GRECIPIENT3333333333333333333333333333333333333333333333333',
          tokenAddress: TOKEN_ADDRESSES.EURC,
          depositedAmount: '300000000',
          withdrawnAmount: '50000000',
          startTime: nowSeconds - 86400 * 8,
          endTime: nowSeconds + 86400 * 2,
          isActive: false,
          isPaused: false,
          events: [{ eventType: 'CANCELLED' }],
          createdAt: new Date((nowSeconds - 86400 * 8) * 1000).toISOString(),
        },
        {
          id: 'uuid-completed-4',
          streamId: '104',
          sender: 'GSENDER4444444444444444444444444444444444444444444444444444',
          recipient: 'GRECIPIENT4444444444444444444444444444444444444444444444444',
          tokenAddress: TOKEN_ADDRESSES.USDC,
          depositedAmount: '200000000',
          withdrawnAmount: '200000000',
          startTime: nowSeconds - 86400 * 20,
          endTime: nowSeconds - 86400 * 2,
          isActive: false,
          isPaused: false,
          events: [{ eventType: 'COMPLETED' }],
          createdAt: new Date((nowSeconds - 86400 * 20) * 1000).toISOString(),
        },
      ],
      total: 4,
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => backendData,
    });
    global.fetch = fetchMock;

    render(<AnalyticsPage />);

    // Verify endpoint called is documented backend stream list
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/v1\/streams$/),
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
    });

    // Wait for the rows to appear in the table
    await waitFor(() => {
      expect(screen.getByTestId('stream-row-101')).toBeInTheDocument();
      expect(screen.getByTestId('stream-row-102')).toBeInTheDocument();
      expect(screen.getByTestId('stream-row-103')).toBeInTheDocument();
      expect(screen.getByTestId('stream-row-104')).toBeInTheDocument();
    });

    // Verify on-chain stream IDs are shown rather than UUIDs
    expect(screen.getByTestId('stream-row-101')).toHaveTextContent('101');
    expect(screen.getByTestId('stream-row-101')).not.toHaveTextContent('uuid-active-1');

    // Verify statuses rendered correctly in the UI
    expect(screen.getByTestId('stream-row-101')).toHaveTextContent(/active/i);
    expect(screen.getByTestId('stream-row-102')).toHaveTextContent(/paused/i);
    expect(screen.getByTestId('stream-row-103')).toHaveTextContent(/cancelled/i);
    expect(screen.getByTestId('stream-row-104')).toHaveTextContent(/completed/i);

    // Verify KPI ribbon rendered
    expect(screen.getByTestId('kpi-ribbon')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-active')).toHaveTextContent('1'); // only stream 101 is active with runway
  });

  it('renders error state on API failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    global.fetch = fetchMock;

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to load streams (500)');
    });
  });
});
