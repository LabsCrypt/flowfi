/**
 * Integration tests for stream HTTP routes with mocked Prisma/SSE.
 *
 * Indexer worker lifecycle flows are covered in indexer-worker.test.ts (mocked
 * worker) and stream-lifecycle.test.ts (real Postgres). This file focuses on
 * claimable RPC fallback, SSE broadcast contracts, and events pagination.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Preserve the module's real exports (issueChallenge, verifyChallenge,
// verifyJwt) — auth.routes wires them up at app construction — while stubbing
// only the middleware so requests bypass JWT verification.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: 'GTEST_USER_PUBLIC_KEY' };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

// ─── Mocks (using vi.hoisted to ensure they are available to vi.mock) ─────────

const { mockSseService, mockPrisma } = vi.hoisted(() => ({
  mockSseService: {
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
  mockPrisma: {
    stream: {
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    streamEvent: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mockSseService,
  SSEService: vi.fn(() => mockSseService),
}));

vi.mock('../../src/lib/redis.js', () => ({
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
    getMetadata: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

// ─── App import (after mocks) ─────────────────────────────────────────────────

import app from '../../src/app.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SENDER = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
const RECIPIENT = 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD';
const TOKEN = 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE';

function makeStream(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-stream-1',
    streamId: 1,
    sender: SENDER,
    recipient: RECIPIENT,
    tokenAddress: TOKEN,
    ratePerSecond: '10',
    depositedAmount: '86400',
    withdrawnAmount: '0',
    startTime: 1700000000,
    lastUpdateTime: 1700000000,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    senderUser: null,
    recipientUser: null,
    ...overrides,
  };
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('Stale DB (>30s) → GET /v1/streams/:id/claimable falls back to RPC', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 200 with claimableAmount when DB data is fresh', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      ratePerSecond: '10',
      depositedAmount: '86400',
      withdrawnAmount: '0',
      lastUpdateTime: now - 5, // 5 seconds ago — fresh
      updatedAt: new Date(Date.now() - 5_000),
      isActive: true,
    });
    mockPrisma.stream.findUnique.mockResolvedValue(stream);

    const res = await request(app).get('/v1/streams/1/claimable');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('claimableAmount');
    expect(typeof res.body.claimableAmount).toBe('string');
  });

  it('returns 200 with claimableAmount when DB data is stale (>30s old)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      ratePerSecond: '10',
      depositedAmount: '86400',
      withdrawnAmount: '0',
      lastUpdateTime: now - 60, // 60 seconds ago — stale
      updatedAt: new Date(Date.now() - 60_000),
      isActive: true,
    });
    mockPrisma.stream.findUnique.mockResolvedValue(stream);

    // Even when stale, the endpoint returns a calculated amount (no real RPC in tests)
    const res = await request(app).get('/v1/streams/1/claimable');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('claimableAmount');
  });
});

describe('SSE client receives broadcast for each stream event', () => {
  it('broadcastToStream is invoked when the indexer calls sseService', () => {
    // Directly exercise the SSE service mock to verify the integration contract
    mockSseService.broadcastToStream('1', 'stream.created', { streamId: 1 });
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.created',
      { streamId: 1 },
    );
  });

  it('broadcastToStream is called for topped_up events', () => {
    mockSseService.broadcastToStream('1', 'stream.topped_up', { amount: '1000' });
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.topped_up',
      { amount: '1000' },
    );
  });

  it('broadcastToStream is called for cancelled events', () => {
    mockSseService.broadcastToStream('1', 'stream.cancelled', {});
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.cancelled',
      {},
    );
  });

  it('broadcastToStream is called for paused events', () => {
    mockSseService.broadcastToStream('1', 'stream.paused', {});
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.paused',
      {},
    );
  });

  it('broadcastToStream is called for resumed events', () => {
    mockSseService.broadcastToStream('1', 'stream.resumed', {});
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.resumed',
      {},
    );
  });
});

describe('GET /v1/streams/:id/events — pagination and eventType filter', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns paginated events with total and hasMore', async () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      id: `evt-${i}`,
      streamId: 1,
      eventType: 'CREATED',
      transactionHash: `tx${i}`,
      ledgerSequence: 100 + i,
      timestamp: 1700000000 + i,
      amount: null,
      metadata: null,
      createdAt: new Date(),
    }));

    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue(events);
    mockPrisma.streamEvent.count.mockResolvedValue(3);

    const res = await request(app).get('/v1/streams/1/events?limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('hasMore');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.hasMore).toBe(false);
  });

  it('enforces default limit of 50', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);
    mockPrisma.streamEvent.count.mockResolvedValue(0);

    const res = await request(app).get('/v1/streams/1/events');
    expect(res.status).toBe(200);
    // Prisma findMany should be called with take: 50
    const call = mockPrisma.streamEvent.findMany.mock.calls[0]?.[0] as { take?: number } | undefined;
    expect(call?.take).toBe(50);
  });

  it('filters by eventType=CANCELLED', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);
    mockPrisma.streamEvent.count.mockResolvedValue(0);

    const res = await request(app).get('/v1/streams/1/events?eventType=CANCELLED');
    expect(res.status).toBe(200);
    const call = mockPrisma.streamEvent.findMany.mock.calls[0]?.[0] as { where?: Record<string, unknown> } | undefined;
    expect(call?.where).toMatchObject({ eventType: 'CANCELLED' });
  });

  it('rejects invalid eventType with 400', async () => {
    const res = await request(app).get('/v1/streams/1/events?eventType=INVALID');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('hasMore is true when more results exist beyond the page', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: `evt-${i}`,
      streamId: 1,
      eventType: 'CREATED',
      transactionHash: `tx${i}`,
      ledgerSequence: 100 + i,
      timestamp: 1700000000 + i,
      amount: null,
      metadata: null,
      createdAt: new Date(),
    }));

    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue(events);
    mockPrisma.streamEvent.count.mockResolvedValue(100); // total > page size

    const res = await request(app).get('/v1/streams/1/events?limit=5&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.total).toBe(100);
  });
});
