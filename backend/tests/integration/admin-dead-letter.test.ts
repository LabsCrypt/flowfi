/**
 * Integration tests for the admin dead-letter quarantine endpoints.
 *
 * Prisma, the SSE service and the Redis cache are mocked so the routes can be
 * exercised without a database or a broker. The auth middleware is NOT stubbed:
 * these routes are the operator interface to a table that can silently drop
 * on-chain events, so the 401/403 paths are part of the contract.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// JWT_SECRET is read when auth.ts is first evaluated, so it has to be in place
// before any import of that module. vi.hoisted runs first for that reason.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-secret-admin-dead-letter';
  process.env.ADMIN_PUBLIC_KEY = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
});

const ADMIN_KEY = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const USER_KEY = 'GAJZR5RMNUNEK7CRXJVEWXZ5XUXWT7FJGILCDDOITF7EC26RPWJ4UVOE';

const mocks = vi.hoisted(() => {
  const deadLetter = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
  };
  return {
    prisma: {
      indexerDeadLetterEvent: deadLetter,
      indexerState: { findUnique: vi.fn(), upsert: vi.fn() },
      stream: { count: vi.fn(), findMany: vi.fn() },
      streamEvent: { count: vi.fn(), findMany: vi.fn() },
      $disconnect: vi.fn(),
    },
    sseService: {
      getClientCount: vi.fn().mockReturnValue(0),
      getStats: vi.fn().mockReturnValue({}),
    },
    cache: { get: vi.fn(), set: vi.fn(), getStats: vi.fn().mockReturnValue({}) },
    processEvent: vi.fn(),
    triggerPoll: vi.fn(),
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

// The indexer service is exercised for real in indexer-service.test.ts; here the
// worker is the boundary, so only that part is stubbed.
vi.mock('../../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    triggerPoll: mocks.triggerPoll,
    processEvent: mocks.processEvent,
  },
}));

vi.mock('../../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { default: adminRoutes } = await import('../../src/routes/v1/admin.routes.js');
const { signJwt } = await import('../../src/middleware/auth.js');
const { xdr } = await import('@stellar/stellar-sdk');

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/v1/admin', adminRoutes);
  return instance;
}

function adminToken(): string {
  return signJwt({ sub: ADMIN_KEY, exp: Math.floor(Date.now() / 1000) + 3600 });
}

function userToken(): string {
  return signJwt({ sub: USER_KEY, exp: Math.floor(Date.now() / 1000) + 3600 });
}

/** A serialisable dead-letter payload, as the worker would have written it. */
function storedPayload(eventId = 'event-1') {
  return JSON.stringify({
    id: eventId,
    type: 'contract',
    ledger: 482910,
    ledgerClosedAt: '2026-09-26T00:00:00Z',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [Buffer.from(xdr.ScVal.scvSymbol('stream_created').toXDR()).toString('base64')],
    value: Buffer.from(xdr.ScVal.scvMap([]).toXDR()).toString('base64'),
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    eventId: 'event-1',
    eventType: 'stream_created',
    txHash: 'abc123',
    ledgerSequence: 482910,
    payload: storedPayload(),
    errorMessage: 'boom',
    attempts: 1,
    cursor: null,
    lastAttemptAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.ADMIN_PUBLIC_KEY;
});

describe('dead-letter auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.indexerDeadLetterEvent.findMany.mockResolvedValue([]);
    mocks.prisma.indexerDeadLetterEvent.count.mockResolvedValue(0);
  });

  it('rejects an unauthenticated list', async () => {
    expect((await request(app()).get('/v1/admin/indexer/dead-letter')).status).toBe(401);
  });

  it('rejects a non-admin list', async () => {
    const res = await request(app())
      .get('/v1/admin/indexer/dead-letter')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Admin access required/i);
  });

  it.each([
    ['get', '/v1/admin/indexer/dead-letter'],
    ['post', '/v1/admin/indexer/dead-letter/replay-all'],
    ['post', '/v1/admin/indexer/dead-letter/row-1/replay'],
    ['delete', '/v1/admin/indexer/dead-letter/row-1'],
  ])('rejects an unauthenticated %s %s', async (method, path) => {
    const res = await request(app())[method as 'get' | 'post' | 'delete'](path);
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/admin/indexer/dead-letter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.indexerDeadLetterEvent.findMany.mockResolvedValue([]);
    mocks.prisma.indexerDeadLetterEvent.count.mockResolvedValue(0);
  });

  it('returns a paginated envelope with the payload intact', async () => {
    mocks.prisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([row()]);
    mocks.prisma.indexerDeadLetterEvent.count.mockResolvedValueOnce(1);

    const res = await request(app())
      .get('/v1/admin/indexer/dead-letter')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      page: 1,
      limit: 25,
      hasMore: false,
    });
    expect(res.body.items[0]).toMatchObject({
      id: 'row-1',
      eventType: 'stream_created',
      txHash: 'abc123',
      ledgerSequence: 482910,
      attempts: 1,
      errorMessage: 'boom',
    });
    // The operator needs the raw payload to diagnose the failure.
    expect(JSON.parse(res.body.items[0].payload).id).toBe('event-1');
  });

  it('passes pagination through to the query', async () => {
    await request(app())
      .get('/v1/admin/indexer/dead-letter?page=3&limit=10')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(mocks.prisma.indexerDeadLetterEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('clamps an over-large limit instead of trusting the client', async () => {
    const res = await request(app())
      .get('/v1/admin/indexer/dead-letter?limit=100000')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.body.limit).toBe(100);
  });

  it('applies ledger, eventType and date filters', async () => {
    await request(app())
      .get('/v1/admin/indexer/dead-letter?ledgerSequence=42&eventType=stream_created&startDate=2026-09-01T00:00:00Z&endDate=2026-09-26T00:00:00Z')
      .set('Authorization', `Bearer ${adminToken()}`);

    const where = mocks.prisma.indexerDeadLetterEvent.findMany.mock.calls[0]![0].where;
    expect(where.ledgerSequence).toBe(42);
    expect(where.eventType).toBe('stream_created');
    expect(where.createdAt).toEqual({
      gte: new Date('2026-09-01T00:00:00Z'),
      lte: new Date('2026-09-26T00:00:00Z'),
    });
  });

  it('rejects an unparseable date rather than silently ignoring it', async () => {
    const res = await request(app())
      .get('/v1/admin/indexer/dead-letter?startDate=not-a-date')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/startDate must be a valid ISO-8601 date/);
    expect(mocks.prisma.indexerDeadLetterEvent.findMany).not.toHaveBeenCalled();
  });

  it('rejects an inverted date range', async () => {
    const res = await request(app())
      .get('/v1/admin/indexer/dead-letter?startDate=2026-09-26T00:00:00Z&endDate=2026-09-01T00:00:00Z')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/startDate must be before endDate/);
  });

  it('answers 500 when the table read fails', async () => {
    mocks.prisma.indexerDeadLetterEvent.findMany.mockRejectedValueOnce(
      new Error('relation does not exist'),
    );

    const res = await request(app())
      .get('/v1/admin/indexer/dead-letter')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to list dead-letter events/);
  });
});

describe('POST /v1/admin/indexer/dead-letter/:id/replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockClear leaves queued `*Once` implementations behind, which would be
    // consumed by the next test instead of this one.
    mocks.processEvent.mockReset();
  });

  it('replays and removes the record', async () => {
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(row());
    mocks.prisma.indexerDeadLetterEvent.delete.mockResolvedValueOnce({});

    const res = await request(app())
      .post('/v1/admin/indexer/dead-letter/row-1/replay')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'row-1', outcome: 'replayed', attempts: 1 });
    expect(mocks.processEvent).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.indexerDeadLetterEvent.delete).toHaveBeenCalledWith({
      where: { id: 'row-1' },
    });
  });

  it('answers 404 for an unknown id', async () => {
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(null);

    const res = await request(app())
      .post('/v1/admin/indexer/dead-letter/nope/replay')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
    expect(mocks.processEvent).not.toHaveBeenCalled();
  });

  it('answers 422 and keeps the row when the replay fails', async () => {
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(row());
    mocks.processEvent.mockRejectedValueOnce(new Error('handler still throws'));
    mocks.prisma.indexerDeadLetterEvent.update.mockResolvedValueOnce({ attempts: 2 });

    const res = await request(app())
      .post('/v1/admin/indexer/dead-letter/row-1/replay')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'replay_failed',
      id: 'row-1',
      attempts: 2,
      errorMessage: 'handler still throws',
    });
    expect(mocks.prisma.indexerDeadLetterEvent.delete).not.toHaveBeenCalled();
  });

  it('answers 422 with a distinct code when the payload cannot be decoded', async () => {
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(
      row({ payload: '{not json' }),
    );
    mocks.prisma.indexerDeadLetterEvent.update.mockResolvedValueOnce({ attempts: 2 });

    const res = await request(app())
      .post('/v1/admin/indexer/dead-letter/row-1/replay')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('undecodable_payload');
    expect(mocks.processEvent).not.toHaveBeenCalled();
  });
});

describe('POST /v1/admin/indexer/dead-letter/replay-all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processEvent.mockReset();
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockReset();
    mocks.prisma.indexerDeadLetterEvent.findMany.mockReset();
  });

  it('summarises per-record outcomes', async () => {
    mocks.prisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([
      { id: 'row-1' },
      { id: 'row-2' },
    ]);
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'row-1' ? row() : row({ id: 'row-2', eventId: 'event-2' }),
    );
    mocks.processEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('still broken'));
    mocks.prisma.indexerDeadLetterEvent.delete.mockResolvedValue({});
    mocks.prisma.indexerDeadLetterEvent.update.mockResolvedValue({ attempts: 2 });

    const res = await request(app())
      .post('/v1/admin/indexer/dead-letter/replay-all')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      attempted: 2,
      replayed: 1,
      failed: 1,
      undecodable: 0,
      notFound: 0,
    });
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      'replayed',
      'failed',
    ]);
  });

  it('is not shadowed by the :id/replay route', async () => {
    mocks.prisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([]);

    const res = await request(app())
      .post('/v1/admin/indexer/dead-letter/replay-all')
      .set('Authorization', `Bearer ${adminToken()}`);

    // If `/:id/replay` had matched first, "replay-all" would be read as an id
    // and the response would be a 404.
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(0);
  });
});

describe('DELETE /v1/admin/indexer/dead-letter/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discards the record and reports what was lost', async () => {
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(row());
    mocks.prisma.indexerDeadLetterEvent.delete.mockResolvedValueOnce({});

    const res = await request(app())
      .delete('/v1/admin/indexer/dead-letter/row-1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      discarded: {
        id: 'row-1',
        eventType: 'stream_created',
        txHash: 'abc123',
        ledgerSequence: 482910,
      },
    });
    expect(mocks.prisma.indexerDeadLetterEvent.delete).toHaveBeenCalledWith({
      where: { id: 'row-1' },
    });
  });

  it('answers 404 for an unknown id without deleting anything', async () => {
    mocks.prisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(null);

    const res = await request(app())
      .delete('/v1/admin/indexer/dead-letter/nope')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
    expect(mocks.prisma.indexerDeadLetterEvent.delete).not.toHaveBeenCalled();
  });
});
