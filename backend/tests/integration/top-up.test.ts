import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const SENDER = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
const OTHER  = 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD';

const STREAM_ID = 42n;
const START_TIME = 1700000000n;
const RATE = 100n;
const INITIAL_DEPOSIT = 86400n;

const streamRow = () => ({
  id: 'uuid-1',
  streamId: STREAM_ID,
  sender: SENDER,
  recipient: OTHER,
  tokenAddress: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
  ratePerSecond: RATE.toString(),
  depositedAmount: INITIAL_DEPOSIT.toString(),
  withdrawnAmount: '0',
  startTime: START_TIME,
  endTime: null,
  lastUpdateTime: START_TIME,
  isPaused: false,
  pausedAt: null,
  totalPausedDuration: 0,
  isActive: true,
});

/**
 * A stream table small enough to hold in memory, with the two things the
 * top-up writers actually depend on: the `(transactionHash, eventType)` unique
 * key, and a `FOR UPDATE` row lock that a writer must hold while it decides
 * whether it is the one that applies a top-up.
 */
class FakeStreams {
  rows = new Map<string, Record<string, unknown>>();
  events = new Map<string, Record<string, unknown>>();
  locksHeld = 0;

  reset() {
    this.rows.clear();
    this.events.clear();
    this.locksHeld = 0;
    this.rows.set(STREAM_ID.toString(), streamRow() as unknown as Record<string, unknown>);
  }

  deposited(): bigint {
    return BigInt(this.rows.get(STREAM_ID.toString())!.depositedAmount as string);
  }

  eventCount(): number {
    return this.events.size;
  }

  /** Mirrors `SELECT ... FROM "Stream" WHERE "streamId" = $1 FOR UPDATE`. */
  lock(streamId: bigint): number {
    this.locksHeld += 1;
    return this.rows.has(streamId.toString()) ? 1 : 0;
  }

  /** The writer must hold the row lock, exactly as Postgres would enforce. */
  private assertLocked() {
    if (this.locksHeld === 0) {
      throw new Error('top-up written without holding the stream row lock');
    }
  }

  tx(): any {
    const self = this;
    return {
      $executeRaw: async (_chunks: unknown, ...values: unknown[]) =>
        self.lock(values[0] as bigint),
      stream: {
        findUniqueOrThrow: async ({ where }: any) => ({ ...self.rows.get(String(where.streamId)) }),
        update: async ({ where, data }: any) => {
          self.assertLocked();
          const row = self.rows.get(String(where.streamId))!;
          Object.assign(row, data);
          return row;
        },
      },
      streamEvent: {
        findUnique: async ({ where }: any) => {
          const { transactionHash, eventType } = where.transactionHash_eventType;
          return self.events.get(`${transactionHash}|${eventType}`) ?? null;
        },
        create: async ({ data }: any) => {
          self.assertLocked();
          self.events.set(`${data.transactionHash}|${data.eventType}`, { ...data });
          return data;
        },
        upsert: async ({ where, create, update }: any) => {
          self.assertLocked();
          const { transactionHash, eventType } = where.transactionHash_eventType;
          const key = `${transactionHash}|${eventType}`;
          const existing = self.events.get(key);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row = { ...create };
          self.events.set(key, row);
          return row;
        },
      },
    };
  }
}

const store = new FakeStreams();

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
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
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
  submitSignedCancel: vi.fn(),
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
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }),
  };
});

// App import after mocks
import app from '../../src/app.js';
import { topUpStream } from '../../src/services/sorobanService.js';
import { swaggerSpec } from '../../src/config/swagger.js';
import { applyToppedUpEvent } from '../../src/services/top-up-writer.js';

const postTopUp = (amount = '1000', streamId = '42') =>
  request(app)
    .post(`/v1/streams/${streamId}/top-up`)
    .set('Authorization', 'Bearer dummy')
    .send({ amount });

/** What the indexer would write for the same transaction the API just sent. */
const indexTopUpEvent = (txHash = 'abc123txhash', absoluteDeposited = '87400') =>
  mockPrisma.$transaction((tx: any) =>
    applyToppedUpEvent(tx, {
      streamId: STREAM_ID,
      txHash,
      amount: '1000',
      newDepositedAmount: absoluteDeposited,
      ledgerSequence: 5_112_233,
      timestamp: 1700000600,
    }),
  );

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /v1/streams/:streamId/top-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(streamRow() as any);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(store.tx()));
  });

  it('returns 200 with txHash on valid request', async () => {
    const res = await postTopUp();

    expect(res.status).toBe(200);
    expect(res.body.txHash).toBe('abc123txhash');
    expect(res.body.streamId).toBe(42);
    expect(topUpStream).toHaveBeenCalledWith(42n, 1000n, SENDER);
  });

  it('documented TopUpResponse schema matches the actual controller response keys (issue #1536)', async () => {
    const res = await postTopUp();

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['depositedAmount', 'streamId', 'txHash']);
    // The handler never returns `newDepositedAmount`; the OpenAPI schema must not either.
    expect(res.body).not.toHaveProperty('newDepositedAmount');

    const schema = (swaggerSpec as any)?.components?.schemas?.TopUpResponse;
    expect(schema).toBeDefined();
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(res.body).sort());
    expect(schema.required.sort()).toEqual(Object.keys(res.body).sort());
  });

  it('returns 400 when amount is missing', async () => {
    const res = await request(app)
      .post('/v1/streams/42/top-up')
      .set('Authorization', 'Bearer dummy')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is not a positive integer string', async () => {
    const res = await postTopUp('-50');

    expect(res.status).toBe(400);
  });

  it('returns 400 when amount is a float string', async () => {
    const res = await postTopUp('1.5');

    expect(res.status).toBe(400);
  });

  it('returns 400 when amount exceeds the maximum allowed length', async () => {
    const res = await postTopUp('1'.repeat(10000));

    expect(res.status).toBe(400);
    expect(topUpStream).not.toHaveBeenCalled();
  });

  it('returns 404 when stream does not exist', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(null);

    const res = await postTopUp('1000', '99');

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

  it('returns 409 when stream is inactive', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue({ ...streamRow(), isActive: false } as any);

    const res = await postTopUp();

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/inactive stream/);
  });

  it('returns 409 when stream is paused', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue({ ...streamRow(), isPaused: true } as any);

    const res = await postTopUp();

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/paused stream/);
  });
});

describe('top-up single-writer race (issue #1848)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(streamRow() as any);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(store.tx()));
  });

  it('writes the amount and its TOPPED_UP marker in one pass', async () => {
    const res = await postTopUp('1000');

    expect(res.status).toBe(200);
    expect(store.deposited()).toBe(87400n);
    expect(store.eventCount()).toBe(1);
    // Extending the deposit must extend the runway, or the stream still ends on
    // the old schedule and the recipient cannot claim what was topped up.
    expect(store.rows.get('42')!.endTime).toBe(START_TIME + 874n);
  });

  it('does not double-count when the indexer commits first', async () => {
    await indexTopUpEvent();

    const res = await postTopUp('1000');

    expect(res.status).toBe(200);
    expect(res.body.depositedAmount).toBe('87400');
    expect(store.deposited()).toBe(87400n);
    expect(store.eventCount()).toBe(1);
  });

  it('does not double-count when the API commits first', async () => {
    const res = await postTopUp('1000');
    expect(res.body.depositedAmount).toBe('87400');

    await indexTopUpEvent();

    expect(store.deposited()).toBe(87400n);
    expect(store.eventCount()).toBe(1);
  });

  it('reconciles the row to the chain value when the API incremented from a stale row', async () => {
    // The API only knows `row + amount`. If the row was already behind the
    // chain, that sum is wrong, and the marker must not lock the error in:
    // the chain's absolute value has to be able to correct it once.
    const res = await postTopUp('1000');
    expect(res.body.depositedAmount).toBe('87400');

    await indexTopUpEvent('abc123txhash', '88400');

    expect(store.deposited()).toBe(88400n);
    expect(store.rows.get('42')!.endTime).toBe(START_TIME + 884n);
    expect(store.eventCount()).toBe(1);
    // Claiming the real ledger position is what retires the marker: a third
    // writer for the same hash is now a replay, not a confirmation.
    expect(store.events.get('abc123txhash|TOPPED_UP')!.ledgerSequence).toBe(5_112_233);
  });

  it('ignores a replay of an event the indexer already reconciled', async () => {
    await indexTopUpEvent('abc123txhash', '87400');

    // A re-read of an older ledger must not roll the absolute value backwards.
    await indexTopUpEvent('abc123txhash', '86400');

    expect(store.deposited()).toBe(87400n);
    expect(store.eventCount()).toBe(1);
  });

  it('reports the indexer amount to the caller whichever writer wins', async () => {
    await indexTopUpEvent('abc123txhash', '87400');
    const viaIndexer = await postTopUp('1000');
    store.reset();
    const viaApi = await postTopUp('1000');

    expect(viaIndexer.body.depositedAmount).toBe(viaApi.body.depositedAmount);
  });

  it('applies two concurrent top-ups of different transactions without losing either', async () => {
    vi.mocked(topUpStream).mockImplementation(async (_id, amount) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `tx-${amount}`;
    });

    const [res1, res2] = await Promise.all([postTopUp('1000'), postTopUp('2000')]);

    expect([res1.status, res2.status]).toEqual([200, 200]);
    expect(store.deposited()).toBe(89400n);
    expect(store.eventCount()).toBe(2);
    expect(Math.max(Number(res1.body.depositedAmount), Number(res2.body.depositedAmount))).toBe(89400);
  });

  it('refuses to write for a stream row that disappeared mid-transaction', async () => {
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      store.rows.delete(STREAM_ID.toString());
      return fn(store.tx());
    });

    const res = await postTopUp();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(store.events.size).toBe(0);
  });
});

describe('top-up error codes (issue #1850)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    vi.mocked(mockPrisma.stream.findUnique).mockResolvedValue(streamRow() as any);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(store.tx()));
  });

  it('leaves the DB untouched and answers 400 TOP_UP_FAILED when the chain call fails', async () => {
    vi.mocked(topUpStream).mockRejectedValueOnce(
      new Error('Transaction failed on-chain: tx_fail_post_submission'),
    );
    const before = store.deposited();

    const res = await postTopUp();

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOP_UP_FAILED');
    expect(store.deposited()).toBe(before);
    expect(store.eventCount()).toBe(0);
  });

  it('answers 5xx when the database fails after the top-up landed on chain', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await postTopUp();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.code).not.toBe('TOP_UP_FAILED');
    // The caller must not be told this is their transaction's fault, or they
    // retry and pay for the top-up twice.
    expect(res.body.error.message).not.toMatch(/on chain/);
  });

  it('answers 5xx, not 4xx, when the guard read fails', async () => {
    vi.mocked(mockPrisma.stream.findUnique).mockRejectedValue(new Error('connection pool exhausted'));

    const res = await postTopUp();

    expect(res.status).toBe(500);
    expect(topUpStream).not.toHaveBeenCalled();
  });

  it('maps a known Prisma failure to its sanitized code', async () => {
    const constraintError = Object.assign(new Error('Unique constraint failed'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });
    mockPrisma.$transaction.mockRejectedValue(constraintError);

    const res = await postTopUp();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_ENTRY');
    expect(JSON.stringify(res.body)).not.toMatch(/Unique constraint failed/);
  });
});
