import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useStream, mapBackendStreamToFlowFiStream } from '../src/hooks/useStream';
import { FlowFiProvider } from '../src/components/FlowFiProvider';

describe('useStream hook', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockBackendStream = {
    id: 'uuid-1234',
    streamId: 42,
    sender: 'GA_SENDER_123',
    recipient: 'GB_RECIPIENT_456',
    tokenAddress: 'CD_TOKEN_789',
    ratePerSecond: '1000',
    depositedAmount: '5000000',
    withdrawnAmount: '1000000',
    startTime: 1700000000,
    lastUpdateTime: 1700000100,
    endTime: 1700005000,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
  };

  it('fetches stream via detail endpoint regardless of configured Soroban RPC URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockBackendStream,
    });
    global.fetch = fetchMock;

    const wrapper = ({ children }: { children: ReactNode }) => (
      <FlowFiProvider
        config={{
          rpcUrl: 'https://soroban-testnet.stellar.org',
          contractId: 'CC_CONTRACT_ID',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }}
      >
        {children}
      </FlowFiProvider>
    );

    const { result } = renderHook(() => useStream('42'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = fetchMock.mock.calls[0]![0];
    // Must call the detail endpoint /api/v1/streams/42, NOT a query param ?id=42
    expect(requestUrl).toBe('/api/v1/streams/42');
    expect(requestUrl).not.toContain('?id=');
    expect(result.current.stream?.id).toBe('42');
  });

  it('maps real backend response into FlowFiStream contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockBackendStream,
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useStream('42'));

    await waitFor(() => expect(result.current.stream).not.toBeNull());

    const stream = result.current.stream!;
    expect(stream.id).toBe('42');
    expect(stream.sender).toBe('GA_SENDER_123');
    expect(stream.recipient).toBe('GB_RECIPIENT_456');
    expect(stream.token).toEqual({
      address: 'CD_TOKEN_789',
      symbol: 'TOKEN',
      decimals: 7,
    });
    expect(stream.depositedAmount).toBe('5000000');
    expect(stream.withdrawnAmount).toBe('1000000');
    expect(stream.remainingBalance).toBe('4000000');
    expect(stream.claimableBalance).toBe('0');
    expect(stream.startTimestamp).toBe(1700000000);
    expect(stream.endTimestamp).toBe(1700005000);
    expect(stream.status).toBe('active');
  });

  it('handles not-found (404) response gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: {
          code: 'NOT_FOUND',
          message: 'Stream not found',
        },
      }),
    });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useStream('999'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.stream).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toMatch(/not found/i);
  });

  it('handles switching stream IDs and cancels stale responses', async () => {
    let resolveFirst: ((val: unknown) => void) | undefined;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const stream2Backend = {
      ...mockBackendStream,
      id: 'uuid-2',
      streamId: 2,
    };

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/1')) {
        return firstPromise;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => stream2Backend,
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, rerender } = renderHook(({ id }) => useStream(id), {
      initialProps: { id: '1' },
    });

    expect(result.current.isLoading).toBe(true);

    // Switch ID to '2' before '1' resolves
    rerender({ id: '2' });

    await waitFor(() => expect(result.current.stream?.id).toBe('2'));
    expect(result.current.stream?.id).toBe('2');

    // Late resolve for stream 1
    resolveFirst!({
      ok: true,
      status: 200,
      json: async () => mockBackendStream,
    });

    // Verify stream 2 is still current
    expect(result.current.stream?.id).toBe('2');
  });

  it('does not fetch when streamId is undefined', () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const { result } = renderHook(() => useStream(undefined));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.stream).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('mapBackendStreamToFlowFiStream', () => {
  it('maps paused and completed status correctly', () => {
    const paused = mapBackendStreamToFlowFiStream({
      streamId: '1',
      isPaused: true,
      isActive: true,
      depositedAmount: '100',
      withdrawnAmount: '0',
    });
    expect(paused?.status).toBe('paused');

    const completed = mapBackendStreamToFlowFiStream({
      streamId: '2',
      isPaused: false,
      isActive: false,
      depositedAmount: '100',
      withdrawnAmount: '100',
    });
    expect(completed?.status).toBe('completed');
  });

  it('maps custom token and usdRate if provided', () => {
    const stream = mapBackendStreamToFlowFiStream({
      streamId: '10',
      token: {
        symbol: 'USDC',
        address: '0xusdc',
        decimals: 6,
      },
      usdRate: 1.05,
    });
    expect(stream?.token).toEqual({
      symbol: 'USDC',
      address: '0xusdc',
      decimals: 6,
    });
    expect(stream?.usdRate).toBe(1.05);
  });
});
