/**
 * Integration tests for GET /v1/events.
 *
 * Verifies the activity-page contract: address filter, event-type filter,
 * pagination via limit/offset, and the shape returned to the frontend
 * (events, total, hasMore).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  prisma: {
    streamEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
  sseService: {
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
    getActiveIpCount: vi.fn().mockReturnValue(0),
    getPerIpPeakConnections: vi.fn().mockReturnValue(0),
    getMaxConnections: vi.fn().mockReturnValue(10000),
    checkCapacity: vi.fn().mockReturnValue({ allowed: true }),
    isShuttingDown: vi.fn().mockReturnValue(false),
    initRedisSubscription: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  default: mocks.prisma,
  prisma: mocks.prisma,
}));

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mocks.sseService,
  SSEService: vi.fn(() => mocks.sseService),
}));

vi.mock('../../src/lib/redis.js', () => ({
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
    getMetadata: vi.fn(),
    getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0, itemCount: 0 }),
    cleanup: vi.fn(),
  },
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

import app from '../../src/app.js';

const ADDR = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    streamId: 1,
    eventType: 'CREATED',
    amount: '1000',
    transactionHash: 'tx-hash',
    ledgerSequence: 1,
    timestamp: 1700000000,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('GET /v1/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests missing the `address` query parameter', async () => {
    const res = await request(app).get('/v1/events');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });

  it('returns the paged event list for the wallet', async () => {
    const events = [makeEvent({ id: 'a', timestamp: 3 }), makeEvent({ id: 'b', timestamp: 2 })];
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce(events);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(5);

    const res = await request(app).get(`/v1/events?address=${ADDR}&limit=2`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body).toMatchObject({ total: 5, limit: 2, offset: 0, hasMore: true });

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      where: { stream: { OR: Array<{ sender?: string; recipient?: string }> } };
      orderBy: { timestamp: string };
      take: number;
      skip: number;
    };
    expect(callArgs.where.stream.OR).toEqual([{ sender: ADDR }, { recipient: ADDR }]);
    expect(callArgs.orderBy).toEqual({ timestamp: 'desc' });
    expect(callArgs.take).toBe(2);
    expect(callArgs.skip).toBe(0);
  });

  it('forwards a comma-separated type filter to Prisma', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

    const res = await request(app).get(
      `/v1/events?address=${ADDR}&type=PAUSED,RESUMED`,
    );
    expect(res.status).toBe(200);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      where: { eventType: { in: string[] } };
    };
    expect(callArgs.where.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
  });

  it('rejects a type filter when no values are valid', async () => {
    const res = await request(app).get(`/v1/events?address=${ADDR}&type=BOGUS`);
    expect(res.status).toBe(400);
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });

  it('supports page-based pagination as a fallback for offset', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(100);

    const res = await request(app).get(
      `/v1/events?address=${ADDR}&limit=10&page=4`,
    );
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(30);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      skip: number;
    };
    expect(callArgs.skip).toBe(30);
  });
});
