import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { fetchIncomingStreams } from './streams';
import { TOKEN_ADDRESSES } from '@/lib/soroban';
import type { BackendStream } from '@/lib/api-types';

describe('fetchIncomingStreams', () => {
  const recipientPublicKey = 'GBXHQ...';
  let originalFetch: typeof global.fetch;
  let fetchMock: Mock;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  const mockStream: BackendStream = {
    id: 'db-id-1',
    streamId: 1,
    sender: 'GBXHQYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYZZZZ',
    recipient: 'GBXHQ...',
    tokenAddress: TOKEN_ADDRESSES.USDC,
    ratePerSecond: '10000000', // 1 USDC per second
    depositedAmount: '100000000', // 10 USDC
    withdrawnAmount: '50000000', // 5 USDC
    startTime: 1000,
    lastUpdateTime: 2000,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  it('advances to the next endpoint on 404 and returns mapped results from the first 2xx', async () => {
    // First call returns 404
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    // Second call returns 200 with an array
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [mockStream],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('db-id-1');
  });

  it('handles array response shapes correctly', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [mockStream, { ...mockStream, id: 'db-id-2' }],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('db-id-1');
    expect(result[1]!.id).toBe('db-id-2');
  });

  it('handles { data: [] } response shapes correctly', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [mockStream] }),
    });

    const result = await fetchIncomingStreams(recipientPublicKey);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('db-id-1');
  });

  it('maps mapBackendStream output correctly: token label resolution + fallback', async () => {
    const unknownTokenStream = {
      ...mockStream,
      tokenAddress: 'CBXHQZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZYYYY',
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [mockStream, unknownTokenStream],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);

    // Resolution based on TOKEN_ADDRESSES
    expect(result[0]!.token).toBe('USDC');
    expect(result[0]!.tokenAddress).toBe(TOKEN_ADDRESSES.USDC);

    // Fallback format
    expect(result[1]!.token).toBe('CBXHQZ...YYYY');
    expect(result[1]!.tokenAddress).toBe(unknownTokenStream.tokenAddress);
  });

  it('maps mapBackendStream output correctly: toTokenAmount scaling', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [mockStream],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);
    
    // 10000000 stroops = 1 token
    expect(result[0]!.ratePerSecond).toBe(1);
    // 100000000 stroops = 10 tokens
    expect(result[0]!.deposited).toBe(10);
    // 50000000 stroops = 5 tokens
    expect(result[0]!.withdrawn).toBe(5);
  });

  it('maps mapBackendStream output correctly: status', async () => {
    const activeStream = { ...mockStream, isActive: true, isPaused: false };
    const pausedStream = { ...mockStream, isActive: true, isPaused: true };
    const completedStream = { ...mockStream, isActive: false, isPaused: false };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [activeStream, pausedStream, completedStream],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);

    expect(result[0]!.status).toBe('Active');
    expect(result[1]!.status).toBe('Paused');
    expect(result[2]!.status).toBe('Completed');
  });

  it('throws the last error when all candidates fail (non-404)', async () => {
    // Both endpoints return 500
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(fetchIncomingStreams(recipientPublicKey)).rejects.toThrow(
      /Failed to fetch incoming streams \(500\)/
    );
  });

  it('throws the last error when all candidates fail (404)', async () => {
    // Both endpoints return 404
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    await expect(fetchIncomingStreams(recipientPublicKey)).rejects.toThrow(
      /Endpoint not found:/
    );
  });

  it('aborts a hung request after the timeout and surfaces a clear error', async () => {
    vi.useFakeTimers();

    // Simulate a backend that never responds: fetch only settles when the
    // AbortController tied to the timeout fires.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted.');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    });

    const pending = fetchIncomingStreams(recipientPublicKey, 5000);
    const assertion = expect(pending).rejects.toThrow(/timed out after 5000ms/);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    vi.useRealTimers();
  });

  describe('pagination normalization', () => {
    it('requests a single capped page with explicit sort metadata', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

      await fetchIncomingStreams(recipientPublicKey);

      const [requestUrl] = fetchMock.mock.calls[0]!;
      const params = new URL(requestUrl as string).searchParams;
      expect(params.get('recipient')).toBe(recipientPublicKey);
      expect(params.get('sort')).toBe('lastUpdateTime');
      expect(params.get('order')).toBe('desc');
      expect(params.get('limit')).toBe('100');
    });

    it('normalizes an empty data page to an empty list', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

      const result = await fetchIncomingStreams(recipientPublicKey);

      expect(result).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('normalizes a bare empty array page to an empty list', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      const result = await fetchIncomingStreams(recipientPublicKey);

      expect(result).toEqual([]);
    });

    it('normalizes a payload without a data key to an empty list', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ meta: { total: 0, page: 1, limit: 100 } }),
      });

      const result = await fetchIncomingStreams(recipientPublicKey);

      expect(result).toEqual([]);
    });

    it('ignores pagination metadata sitting next to the records', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [mockStream],
          meta: { total: 1, page: 1, limit: 100, totalPages: 1 },
        }),
      });

      const result = await fetchIncomingStreams(recipientPublicKey);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('db-id-1');
      expect(result[0]!.status).toBe('Active');
    });

    it('defaults missing optional pause fields on malformed records', async () => {
      const recordWithoutPauseFields = {
        id: 'db-id-4',
        streamId: 4,
        sender: 'GBXHQYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYZZZZ',
        recipient: 'GBXHQ...',
        tokenAddress: TOKEN_ADDRESSES.USDC,
        ratePerSecond: '10000000',
        depositedAmount: '100000000',
        withdrawnAmount: '50000000',
        startTime: 1000,
        lastUpdateTime: 2000,
        isActive: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      } as BackendStream;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [recordWithoutPauseFields] }),
      });

      const result = await fetchIncomingStreams(recipientPublicKey);

      expect(result[0]!.isPaused).toBe(false);
      expect(result[0]!.pausedAt).toBeNull();
      expect(result[0]!.totalPausedDuration).toBe(0);
      expect(result[0]!.status).toBe('Completed');
    });

    it('maps zero-valued stroop amounts at the lower boundary', async () => {
      const zeroedStream = {
        ...mockStream,
        ratePerSecond: '0',
        depositedAmount: '0',
        withdrawnAmount: '0',
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [zeroedStream],
      });

      const result = await fetchIncomingStreams(recipientPublicKey);

      expect(result[0]!.ratePerSecond).toBe(0);
      expect(result[0]!.deposited).toBe(0);
      expect(result[0]!.withdrawn).toBe(0);
    });
  });
});
