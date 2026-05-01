import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const SENDER = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
const OTHER  = 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD';

const mockStream = {
  id: 'uuid-1',
  streamId: 42,
  sender: SENDER,
  recipient: OTHER,
  tokenAddress: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
  ratePerSecond: '100',
  depositedAmount: '86400',
  withdrawnAmount: '0',
  startTime: 1700000000,
  endTime: null,
  lastUpdateTime: 1700000000,
  isPaused: false,
  pausedAt: null,
  totalPausedDuration: 0,
  isActive: true,
};

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    stream: {
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn(),
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

// ── Mocks must be declared before app import ──────────────────────────────────

vi.mock('../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../src/services/sorobanService.js', () => ({
  getStreamFromChain: vi.fn().mockResolvedValue(null),
  getClaimableFromChain: vi.fn().mockResolvedValue(null),
  isStale: vi.fn().mockReturnValue(false),
  topUpStream: vi.fn().mockResolvedValue('abc123txhash'),
  pauseStream: vi.fn(),
  resumeStream: vi.fn(),
  withdrawStream: vi.fn(),
  cancelStream: vi.fn(),
}));

vi.mock('../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = { publicKey: req.headers['x-test-caller'] ?? SENDER };
    next();
  }),
}));

// App import after mocks
import app from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { topUpStream } from '../../src/services/sorobanService.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /v1/streams/:streamId/top-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(mockStream as any);
    vi.mocked(mockPrisma.stream.update).mockResolvedValue({ ...mockStream, depositedAmount: '87400' } as any);
  });

  it('returns 200 with txHash on valid request', async () => {
    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe('abc123txhash');
    expect(res.body.streamId).toBe(42);
    expect(topUpStream).toHaveBeenCalledWith(42, 1000n, SENDER);
  });

  it('returns 400 when amount is missing', async () => {
    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is not a positive integer string', async () => {
    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '-50' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is a float string', async () => {
    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1.5' });

    expect(res.status).toBe(400);
  });

  it('returns 404 when stream does not exist', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(null);

    const res = await request(app)
      .post('/v1/streams/99/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not the sender', async () => {
    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .set('x-test-caller', OTHER)
      .send({ amount: '1000' });

    expect(res.status).toBe(403);
  });

  it('updates depositedAmount in DB on success', async () => {
    await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 42 },
        data: expect.objectContaining({ depositedAmount: '87400' }),
      }),
    );
  });
});
