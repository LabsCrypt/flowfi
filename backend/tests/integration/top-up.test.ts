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
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
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

// Preserve the module's real exports (issueChallenge, verifyChallenge,
// verifyJwt) — auth.routes wires them up at app construction — while stubbing
// only the middleware so requests bypass JWT verification.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn((req: any, _res: any, next: any) => {
      req.user = { publicKey: req.headers['x-test-caller'] ?? SENDER };
      next();
    }),
    requireAdmin: vi.fn((_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    }),
  };
});

// App import after mocks
import app from '../../src/app.js';
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
    expect(topUpStream).toHaveBeenCalledWith(42n, 1000n, SENDER);
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
    // After $executeRawUnsafe, findUnique returns the updated stream
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue({ ...mockStream, depositedAmount: '87400' } as any);

    await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    // Verify the atomic SQL increment was called
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('returns 409 when stream is inactive', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue({ ...mockStream, isActive: false } as any);

    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/inactive stream/);
  });

  it('returns 409 when stream is paused', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue({ ...mockStream, isPaused: true } as any);

    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/paused stream/);
  });

  it('leaves DB unchanged when topUpStream fails on-chain', async () => {
    vi.mocked(topUpStream).mockRejectedValueOnce(
      new Error('Transaction failed on-chain: tx_fail_post_submission')
    );

    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });

    expect(res.status).toBe(400);
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
  });

  it('handles concurrent top-ups correctly without lost updates', async () => {
    // Both requests read the same initial state
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(mockStream as any);
    
    // Simulate some delay in the on-chain transaction
    vi.mocked(topUpStream).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'txhash-mock';
    });
    
    // We also need to implement $executeRaw to mock the atomic DB update
    // because that's what we will change the implementation to use.
    // However, if it's the OLD implementation, it calls update().
    // We should make the mocked executeRaw update a local variable and 
    // also make update() do the same, so we can test both the failure and success.
    
    let currentDeposited = BigInt(mockStream.depositedAmount);

    vi.mocked(mockPrisma.$executeRawUnsafe).mockImplementation(async (query: any, ...values: any[]) => {
      const amountToAdd = BigInt(values[0]);
      currentDeposited += amountToAdd;
      return 1 as any;
    });

    vi.mocked(mockPrisma.stream.findUnique).mockImplementation(async () => {
      return { ...mockStream, depositedAmount: currentDeposited.toString() } as any;
    });

    // Actually, to make the test pass after the fix, the best way to do atomic update is to do a transaction where we re-fetch the stream.
    // Let's first just test if it works with the old implementation (should fail).
    
    const req1 = request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '1000' });
      
    const req2 = request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({ amount: '2000' });
      
    const [res1, res2] = await Promise.all([req1, req2]);
    
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    
    // The initial amount is 86400. We add 1000 and 2000.
    // 86400 + 1000 + 2000 = 89400.
    // Because we mock Prisma in vitest, the controller's Prisma calls will hit our mock.
    // We will assert on the final 'depositedAmount' returned in the response, or what was sent to Prisma.
    // Since the API returns depositedAmount, let's just check the response body.
    
    // If it lost update, one response will be 87400 and the other 88400.
    // If it didn't lose update, the second one should be 89400.
    const amt1 = parseInt(res1.body.depositedAmount);
    const amt2 = parseInt(res2.body.depositedAmount);
    expect(Math.max(amt1, amt2)).toBe(89400);
  });

});
