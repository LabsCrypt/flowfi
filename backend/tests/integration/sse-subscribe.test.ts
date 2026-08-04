/**
 * Integration tests for GET /v1/events/subscribe.
 *
 * Verifies malformed query params (e.g. a non-numeric streamId) are rejected
 * with a clean 400 by the Zod schema, never surfacing as an uncaught 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  prisma: {
    stream: {
      findMany: vi.fn(),
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
import { signJwt } from '../../src/middleware/auth.js';

const ADDR = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
const now = Math.floor(Date.now() / 1000);
const token = signJwt({ sub: ADDR, iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });

describe('GET /v1/events/subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.stream.findMany.mockResolvedValue([]);
  });

  it('returns 400 with a descriptive error for a malformed (non-numeric) streamId, not a 500', async () => {
    const res = await request(app)
      .get('/v1/events/subscribe?streams=not-a-numeric-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid subscription parameters');
    expect(res.body.errors).toBeDefined();
  });

  it('rejects requests missing authentication', async () => {
    const res = await request(app).get('/v1/events/subscribe?streams=not-a-numeric-id');
    expect(res.status).toBe(401);
  });
});
