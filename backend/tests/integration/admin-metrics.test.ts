/**
 * Integration tests for GET /v1/admin/metrics.
 *
 * Mocks the Prisma client, SSE service, and Redis-backed cache so the
 * endpoint can be exercised in CI without a database. Admin auth is
 * bypassed by stubbing the middleware to a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// vi.mock calls are hoisted, so any references must come from vi.hoisted().
const mocks = vi.hoisted(() => {
  return {
    sseService: {
      broadcastToStream: vi.fn(),
      broadcastToUser: vi.fn(),
      addClient: vi.fn(),
      removeClient: vi.fn(),
      getClientCount: vi.fn().mockReturnValue(7),
      getActiveIpCount: vi.fn().mockReturnValue(2),
      getPerIpPeakConnections: vi.fn().mockReturnValue(3),
      getMaxConnections: vi.fn().mockReturnValue(10000),
      checkCapacity: vi.fn().mockReturnValue({ allowed: true }),
      isShuttingDown: vi.fn().mockReturnValue(false),
      initRedisSubscription: vi.fn().mockResolvedValue(undefined),
    },
    cache: {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      del: vi.fn(),
      getMetadata: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        hits: 0,
        misses: 0,
        hitRate: 0,
        itemCount: 0,
      }),
      cleanup: vi.fn(),
    },
    prisma: {
      stream: {
        count: vi.fn(),
        findMany: vi.fn(),
      },
      streamEvent: {
        count: vi.fn(),
        findMany: vi.fn(),
      },
      indexerState: {
        findUnique: vi.fn(),
      },
      $disconnect: vi.fn(),
    },
  };
});

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mocks.sseService,
  SSEService: vi.fn(() => mocks.sseService),
}));

vi.mock('../../src/lib/redis.js', () => ({
  cache: mocks.cache,
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  default: mocks.prisma,
  prisma: mocks.prisma,
}));

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );
  return {
    ...actual,
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/services/indexerService.js', () => ({
  getIndexerStatus: vi.fn().mockResolvedValue({}),
  resetIndexer: vi.fn().mockResolvedValue(undefined),
  replayFromLedger: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import app after mocks are registered ────────────────────────────────────

import app from '../../src/app.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupCounts({
  total = 10,
  active = 6,
  paused = 1,
  cancelled = 2,
  completed = 1,
}: Partial<Record<'total' | 'active' | 'paused' | 'cancelled' | 'completed', number>> = {}) {
  // Order in admin.routes.ts: active -> paused -> total -> cancelled -> completed.
  mocks.prisma.stream.count
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce(paused)
    .mockResolvedValueOnce(total)
    .mockResolvedValueOnce(cancelled)
    .mockResolvedValueOnce(completed);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /v1/admin/metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.get.mockReturnValue(null);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.indexerState.findUnique.mockResolvedValue(null);
    mocks.prisma.stream.findMany.mockResolvedValue([]);
  });

  it('returns the snake_case summary required by the public contract', async () => {
    setupCounts({ total: 12, active: 7, paused: 2, cancelled: 2, completed: 1 });
    mocks.prisma.stream.findMany.mockResolvedValue([
      { withdrawnAmount: '500' },
      { withdrawnAmount: '1500' },
      { withdrawnAmount: '0' },
    ]);

    const res = await request(app).get('/v1/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_streams: 12,
      active_streams: 7,
      paused_streams: 2,
      completed_streams: 1,
      cancelled_streams: 2,
      total_volume_streamed: '2000',
    });
  });

  it('preserves precision for very large i128 withdrawn sums', async () => {
    setupCounts();
    // Two values whose sum overflows JS safe-integer range — must round-trip
    // as the exact string.
    mocks.prisma.stream.findMany.mockResolvedValue([
      { withdrawnAmount: '9007199254740993' },
      { withdrawnAmount: '9007199254740993' },
    ]);

    const res = await request(app).get('/v1/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.total_volume_streamed).toBe('18014398509481986');
  });

  it('caches the response for 60 seconds', async () => {
    setupCounts({ total: 4, active: 4 });

    const first = await request(app).get('/v1/admin/metrics');
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');

    expect(mocks.cache.set).toHaveBeenCalledTimes(1);
    expect(mocks.cache.set).toHaveBeenCalledWith(
      'admin:metrics',
      expect.objectContaining({ total_streams: 4 }),
      60,
    );
  });

  it('serves a cached response without re-querying the database', async () => {
    const cachedPayload = {
      total_streams: 99,
      active_streams: 50,
      paused_streams: 5,
      completed_streams: 30,
      cancelled_streams: 14,
      total_volume_streamed: '123456789',
    };
    mocks.cache.get.mockReturnValueOnce(cachedPayload);

    const res = await request(app).get('/v1/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body).toMatchObject(cachedPayload);
    expect(mocks.prisma.stream.count).not.toHaveBeenCalled();
    expect(mocks.prisma.stream.findMany).not.toHaveBeenCalled();
  });
});
