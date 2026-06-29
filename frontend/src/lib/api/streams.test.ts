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
    expect(result[0].id).toBe('db-id-1');
  });

  it('handles array response shapes correctly', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [mockStream, { ...mockStream, id: 'db-id-2' }],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('db-id-1');
    expect(result[1].id).toBe('db-id-2');
  });

  it('handles { data: [] } response shapes correctly', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [mockStream] }),
    });

    const result = await fetchIncomingStreams(recipientPublicKey);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('db-id-1');
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
    expect(result[0].token).toBe('USDC');
    expect(result[0].tokenAddress).toBe(TOKEN_ADDRESSES.USDC);

    // Fallback format
    expect(result[1].token).toBe('CBXHQZ...YYYY');
    expect(result[1].tokenAddress).toBe(unknownTokenStream.tokenAddress);
  });

  it('maps mapBackendStream output correctly: toTokenAmount scaling', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [mockStream],
    });

    const result = await fetchIncomingStreams(recipientPublicKey);
    
    // 10000000 stroops = 1 token
    expect(result[0].ratePerSecond).toBe(1);
    // 100000000 stroops = 10 tokens
    expect(result[0].deposited).toBe(10);
    // 50000000 stroops = 5 tokens
    expect(result[0].withdrawn).toBe(5);
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

    expect(result[0].status).toBe('Active');
    expect(result[1].status).toBe('Paused');
    expect(result[2].status).toBe('Completed');
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
});
