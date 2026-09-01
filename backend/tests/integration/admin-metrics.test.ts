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
    pool: {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
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
  pool: mocks.pool,
}));

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/auth.js')>(
    '../../src/middleware/auth.js',
  );
  return actual;
});

vi.mock('../../src/services/indexerService.js', () => ({
  getIndexerStatus: vi.fn().mockResolvedValue({}),
  resetIndexer: vi.fn().mockResolvedValue(undefined),
  replayFromLedger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    getEventCounters: vi.fn().mockReturnValue({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    }),
  },
  SorobanEventWorker: vi.fn(),
}));

// ─── Import app and auth after mocks are registered ──────────────────────────

import app from '../../src/app.js';
import { sorobanEventWorker } from '../../src/workers/soroban-event-worker.js';
import { signJwt } from '../../src/middleware/auth.js';
import {
  getIndexerStatus,
  resetIndexer,
  replayFromLedger,
} from '../../src/services/indexerService.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADMIN_PUBLIC_KEY = 'GADMIN12345678901234567890123456789012345678901234567890';
const NON_ADMIN_PUBLIC_KEY = 'GUSER12345678901234567890123456789012345678901234567890';

function createToken(publicKey: string = ADMIN_PUBLIC_KEY): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: publicKey,
    iat: now,
    exp: now + 3600,
    iss: 'flowfi-api',
    aud: 'flowfi-api',
  });
}

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

describe('GET /v1/events/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_PUBLIC_KEY = ADMIN_PUBLIC_KEY;
  });

  it('enforces requireAdmin (401 without token, 403 with non-admin token)', async () => {
    const noTokenRes = await request(app).get('/v1/events/stats');
    expect(noTokenRes.status).toBe(401);

    const nonAdminRes = await request(app)
      .get('/v1/events/stats')
      .set('Authorization', `Bearer ${createToken(NON_ADMIN_PUBLIC_KEY)}`);
    expect(nonAdminRes.status).toBe(403);

    const adminRes = await request(app)
      .get('/v1/events/stats')
      .set('Authorization', `Bearer ${createToken()}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body).toMatchObject({
      activeConnections: expect.any(Number),
      activeIps: expect.any(Number),
      perIpPeakConnections: expect.any(Number),
      maxConnections: expect.any(Number),
      timestamp: expect.any(String),
    });
  });
});

describe('GET /v1/admin/metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_PUBLIC_KEY = ADMIN_PUBLIC_KEY;
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

    const res = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

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

    const res = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.total_volume_streamed).toBe('18014398509481986');
  });

  it('caches the response for 60 seconds', async () => {
    setupCounts({ total: 4, active: 4 });

    const first = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);
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
      indexer: {
        lastLedger: 10,
        lagSeconds: 1,
        lastUpdated: null,
        eventsProcessed: 0,
        eventsFailed: 0,
        lastErrorAt: null,
        degraded: false,
      },
    };
    mocks.cache.get.mockReturnValueOnce(cachedPayload);

    const res = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body).toMatchObject(cachedPayload);
    expect(mocks.prisma.stream.count).not.toHaveBeenCalled();
    expect(mocks.prisma.stream.findMany).not.toHaveBeenCalled();
  });

  it('exposes indexer event-processing counters and degraded signal (#844)', async () => {
    setupCounts();
    vi.mocked(sorobanEventWorker.getEventCounters).mockReturnValueOnce({
      eventsProcessed: 40,
      eventsFailed: 12,
      lastErrorAt: '2026-07-27T08:00:00.000Z',
      degraded: true,
    });

    const res = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.indexer).toMatchObject({
      eventsProcessed: 40,
      eventsFailed: 12,
      lastErrorAt: '2026-07-27T08:00:00.000Z',
      degraded: true,
    });
  });

  it('merges live indexer counters into a cached metrics response', async () => {
    mocks.cache.get.mockReturnValueOnce({
      total_streams: 1,
      indexer: {
        lastLedger: 5,
        lagSeconds: 2,
        lastUpdated: null,
        eventsProcessed: 0,
        eventsFailed: 0,
        lastErrorAt: null,
        degraded: false,
      },
    });
    vi.mocked(sorobanEventWorker.getEventCounters).mockReturnValueOnce({
      eventsProcessed: 9,
      eventsFailed: 3,
      lastErrorAt: '2026-07-27T09:00:00.000Z',
      degraded: true,
    });

    const res = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body.indexer).toMatchObject({
      lastLedger: 5,
      eventsProcessed: 9,
      eventsFailed: 3,
      lastErrorAt: '2026-07-27T09:00:00.000Z',
      degraded: true,
    });
  });

  it('includes a calculatedAt timestamp in valid ISO 8601 format (#1240)', async () => {
    setupCounts({ total: 5, active: 3 });
    mocks.cache.getMetadata.mockReturnValue({
      createdAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:01:00.000Z',
    });

    const res = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.calculatedAt).toBe('string');
    expect(res.body.calculatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Date.parse(res.body.calculatedAt)).not.toBeNaN();
    // Reflects when the aggregation ran, not when the response was serialized.
    expect(res.body.calculatedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(res.body.calculatedAt).not.toBe(new Date().toISOString());
  });

  it('keeps calculatedAt stable across responses served from the same cache entry (#1240)', async () => {
    const cachedPayload = {
      total_streams: 99,
      active_streams: 50,
      paused_streams: 5,
      completed_streams: 30,
      cancelled_streams: 14,
      total_volume_streamed: '123456789',
      indexer: {
        lastLedger: 10,
        lagSeconds: 1,
        lastUpdated: null,
        eventsProcessed: 0,
        eventsFailed: 0,
        lastErrorAt: null,
        degraded: false,
      },
    };
    const aggregationTime = '2026-08-01T00:00:00.000Z';
    mocks.cache.get.mockReturnValue(cachedPayload);
    mocks.cache.getMetadata.mockReturnValue({
      createdAt: aggregationTime,
      expiresAt: '2026-08-01T00:01:00.000Z',
    });

    const first = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);
    const second = await request(app)
      .get('/v1/admin/metrics')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers['x-cache']).toBe('HIT');
    expect(second.headers['x-cache']).toBe('HIT');
    // Both requests served from the same cache entry: calculatedAt must equal
    // the aggregation time and must NOT drift to "now" on each call.
    expect(first.body.calculatedAt).toBe(aggregationTime);
    expect(second.body.calculatedAt).toBe(aggregationTime);
    expect(second.body.calculatedAt).toEqual(first.body.calculatedAt);
    expect(second.body.calculatedAt).not.toBe(new Date().toISOString());
  });
});

describe('GET /v1/admin/indexer/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_PUBLIC_KEY = ADMIN_PUBLIC_KEY;
  });

  it('enforces requireAdmin (401 without token, 403 with non-admin token)', async () => {
    const noTokenRes = await request(app).get('/v1/admin/indexer/status');
    expect(noTokenRes.status).toBe(401);

    const nonAdminRes = await request(app)
      .get('/v1/admin/indexer/status')
      .set('Authorization', `Bearer ${createToken(NON_ADMIN_PUBLIC_KEY)}`);
    expect(nonAdminRes.status).toBe(403);
    expect(nonAdminRes.body.error).toBe('Forbidden');
  });

  it('returns status 200 with indexer status data for admin', async () => {
    const mockStatus = {
      lastLedger: 12345,
      lastCursor: 'cursor_abc',
      updatedAt: '2026-08-08T00:00:00.000Z',
      lagSeconds: 12,
    };
    vi.mocked(getIndexerStatus).mockResolvedValueOnce(mockStatus as any);

    const res = await request(app)
      .get('/v1/admin/indexer/status')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockStatus);
    expect(getIndexerStatus).toHaveBeenCalledTimes(1);
  });

  it('returns status 500 if getIndexerStatus throws', async () => {
    vi.mocked(getIndexerStatus).mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .get('/v1/admin/indexer/status')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch indexer status' });
  });
});

describe('POST /v1/admin/indexer/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_PUBLIC_KEY = ADMIN_PUBLIC_KEY;
    vi.mocked(resetIndexer).mockResolvedValue(undefined);
  });

  it('enforces requireAdmin (401 without token, 403 with non-admin token)', async () => {
    const noTokenRes = await request(app)
      .post('/v1/admin/indexer/reset')
      .send({ ledger: 100 });
    expect(noTokenRes.status).toBe(401);

    const nonAdminRes = await request(app)
      .post('/v1/admin/indexer/reset')
      .set('Authorization', `Bearer ${createToken(NON_ADMIN_PUBLIC_KEY)}`)
      .send({ ledger: 100 });
    expect(nonAdminRes.status).toBe(403);
  });

  it('returns 400 when ledger is missing, negative, or non-integer', async () => {
    const cases = [
      {},
      { ledger: -1 },
      { ledger: -100 },
      { ledger: 12.34 },
      { ledger: 'not-a-number' },
    ];

    for (const body of cases) {
      const res = await request(app)
        .post('/v1/admin/indexer/reset')
        .set('Authorization', `Bearer ${createToken()}`)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'ledger must be a non-negative integer' });
    }

    expect(resetIndexer).not.toHaveBeenCalled();
  });

  it('returns 200 and calls resetIndexer with parsed ledger for valid requests', async () => {
    const validCases = [
      { body: { ledger: 500 }, expected: 500 },
      { body: { ledger: 0 }, expected: 0 },
      { body: { ledger: '123' }, expected: 123 },
    ];

    for (const { body, expected } of validCases) {
      const res = await request(app)
        .post('/v1/admin/indexer/reset')
        .set('Authorization', `Bearer ${createToken()}`)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, lastLedger: expected });
      expect(resetIndexer).toHaveBeenCalledWith(expected);
    }
  });

  it('returns 500 when resetIndexer throws an error', async () => {
    vi.mocked(resetIndexer).mockRejectedValueOnce(new Error('Reset operation failed'));

    const res = await request(app)
      .post('/v1/admin/indexer/reset')
      .set('Authorization', `Bearer ${createToken()}`)
      .send({ ledger: 100 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Reset failed' });
  });
});

describe('POST /v1/admin/indexer/replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_PUBLIC_KEY = ADMIN_PUBLIC_KEY;
    vi.mocked(replayFromLedger).mockResolvedValue(undefined as any);
  });

  it('enforces requireAdmin (401 without token, 403 with non-admin token)', async () => {
    const noTokenRes = await request(app).post('/v1/admin/indexer/replay?from_ledger=100');
    expect(noTokenRes.status).toBe(401);

    const nonAdminRes = await request(app)
      .post('/v1/admin/indexer/replay?from_ledger=100')
      .set('Authorization', `Bearer ${createToken(NON_ADMIN_PUBLIC_KEY)}`);
    expect(nonAdminRes.status).toBe(403);
  });

  it('returns 400 when from_ledger query parameter is missing, negative, or non-integer', async () => {
    const queryUrls = [
      '/v1/admin/indexer/replay',
      '/v1/admin/indexer/replay?from_ledger=-1',
      '/v1/admin/indexer/replay?from_ledger=-50',
      '/v1/admin/indexer/replay?from_ledger=3.14',
      '/v1/admin/indexer/replay?from_ledger=invalid',
    ];

    for (const url of queryUrls) {
      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${createToken()}`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'from_ledger must be a non-negative integer' });
    }

    expect(replayFromLedger).not.toHaveBeenCalled();
  });

  it('returns 202 and calls replayFromLedger with parsed from_ledger for valid requests', async () => {
    const validCases = [
      { url: '/v1/admin/indexer/replay?from_ledger=200', expected: 200 },
      { url: '/v1/admin/indexer/replay?from_ledger=0', expected: 0 },
    ];

    for (const { url, expected } of validCases) {
      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${createToken()}`);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ ok: true, replayingFrom: expected });
      expect(replayFromLedger).toHaveBeenCalledWith(expected);
    }
  });

  it('returns 500 when replayFromLedger throws an error', async () => {
    vi.mocked(replayFromLedger).mockRejectedValueOnce(new Error('Replay operation failed'));

    const res = await request(app)
      .post('/v1/admin/indexer/replay?from_ledger=200')
      .set('Authorization', `Bearer ${createToken()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Replay failed' });
  });
});

