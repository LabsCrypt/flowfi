import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, sseMock } = vi.hoisted(() => ({
  prismaMock: {
    stream: { findMany: vi.fn() },
    alertHistory: { findMany: vi.fn(), create: vi.fn() },
  },
  sseMock: {
    broadcastToUser: vi.fn(),
    broadcastToStream: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/services/sse.service.js', () => ({ sseService: sseMock }));

import { runStreamRunwayCheck } from '../src/workers/stream-runway-worker.js';

const NOW = Math.floor(Date.now() / 1000);

/** A stream with ~10s of runway: past the 24h threshold, so it would alert. */
function makeStream(streamId: number) {
  return {
    id: `row-${streamId}`,
    streamId: BigInt(streamId),
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    tokenAddress: 'GTOKEN',
    ratePerSecond: '1',
    depositedAmount: '1000',
    withdrawnAmount: '0',
    startTime: BigInt(NOW - 1000),
    lastUpdateTime: BigInt(NOW - 1000),
    endTime: null,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('runStreamRunwayCheck query bounds (#1899)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.alertHistory.create.mockResolvedValue({});
    prismaMock.alertHistory.findMany.mockResolvedValue([]);
  });

  it('pages through streams and dedups per page, not per stream', async () => {
    // 1_200 active streams: three pages at the worker's page size of 500.
    const all = Array.from({ length: 1_200 }, (_, i) => makeStream(i + 1));
    prismaMock.stream.findMany.mockImplementation(async ({ take, cursor }) => {
      const start = cursor ? all.findIndex((s) => s.streamId === cursor.streamId) + 1 : 0;
      return all.slice(start, start + take);
    });

    await runStreamRunwayCheck();

    const streamQueries = prismaMock.stream.findMany.mock.calls.length;
    const dedupQueries = prismaMock.alertHistory.findMany.mock.calls.length;

    // One page query per 500 streams; the short third page ends the loop.
    expect(streamQueries).toBe(3);

    // Two dedup queries per page — one per alert type — regardless of how many
    // streams are on it. Before #1899 this was one or two queries per stream.
    expect(dedupQueries).toBe(6);
    expect(dedupQueries).toBeLessThan(all.length);
  });

  it('skips streams that already received the alert inside the window', async () => {
    const page = [makeStream(1), makeStream(2)];
    prismaMock.stream.findMany
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);

    // Stream 1 already got its critical alert this window.
    prismaMock.alertHistory.findMany.mockImplementation(async ({ where }) =>
      where.alertType === 'CRITICAL_24H' ? [{ streamId: 1n }] : [],
    );

    await runStreamRunwayCheck();

    expect(prismaMock.alertHistory.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.alertHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ streamId: 2n }) }),
    );
    expect(sseMock.broadcastToStream).toHaveBeenCalledTimes(1);
  });
});
