import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';

const {
  mockWithdraw,
  mockPrisma,
  mockClaimable,
  currentUser,
} = vi.hoisted(() => ({
  mockWithdraw: vi.fn(),
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
  },
  currentUser: { publicKey: '' },
  mockClaimable: {
    getClaimableAmount: vi.fn(),
  },
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../../src/services/claimable.service.js', () => ({
  claimableAmountService: mockClaimable,
}));

vi.mock('../../../src/services/sorobanService.js', () => ({
  withdraw: mockWithdraw,
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn().mockReturnValue(false),
}));

// Simple factory — no importOriginal — reliable with pool:forks.
vi.mock('../../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: currentUser.publicKey };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

import app from '../../../src/app.js';

function makeKeypair() {
  return StellarSdk.Keypair.random();
}

function setAuthAs(keypair: StellarSdk.Keypair): string {
  currentUser.publicKey = keypair.publicKey();
  return 'mock-token';
}

describe('POST /api/v1/streams/:streamId/withdraw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully withdraws claimable amount for the recipient', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 123;
    const stream = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: Math.floor(Date.now() / 1000) - 100,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 50,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

    mockPrisma.stream.findUnique.mockResolvedValue(stream);
    mockClaimable.getClaimableAmount.mockReturnValue({
      streamId: BigInt(streamId),
      claimableAmount: '100',
      actionable: true,
      calculatedAt: Math.floor(Date.now() / 1000),
      cached: false,
    });
    mockWithdraw.mockResolvedValue({ txHash: 'withdraw-tx-hash' });
    // Mock $transaction to simulate the withdraw handler's transaction.
    // First $executeRawUnsafe call is the event INSERT (returns 1 = inserted),
    // second is the balance UPDATE (returns undefined).
    let safeExecCount = 0;
    mockPrisma.$executeRawUnsafe.mockImplementation(async (_sql: string) => {
      safeExecCount += 1;
      return safeExecCount === 1 ? 1 : undefined;
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      safeExecCount = 0; // reset per transaction
      mockPrisma.stream.findUnique.mockResolvedValueOnce({
        ...stream,
        withdrawnAmount: '200',
      });
      return fn(mockPrisma);
    });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId,
      txHash: 'withdraw-tx-hash',
    });

    // Verify service call with new signature (streamId, recipientAddress)
    expect(mockWithdraw).toHaveBeenCalledWith(BigInt(streamId), recipient.publicKey());
    
    // Verify the event INSERT and balance UPDATE SQL were both executed
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();

    // Event creation now happens inside the transaction via INSERT, not upsert
    expect(mockPrisma.streamEvent.upsert).not.toHaveBeenCalled();
  });

  it('returns 403 if the caller is not the recipient', async () => {
    const someoneElse = makeKeypair();
    const token = setAuthAs(someoneElse);

    const streamId = 123;
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: makeKeypair().publicKey(), // Different recipient
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      isActive: true,
      isPaused: false,
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  it('returns 404 if stream not found', async () => {
    const user = makeKeypair();
    const token = setAuthAs(user);

    mockPrisma.stream.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post('/v1/streams/999/withdraw')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Stream not found');
  });

  it('returns 409 if no claimable balance available', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 123;
    const now = Math.floor(Date.now() / 1000);
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '0',
      startTime: now + 100, // Starts in the future
      lastUpdateTime: now + 100,
      isActive: true,
      isPaused: false,
      updatedAt: new Date(),
    });
    mockClaimable.getClaimableAmount.mockReturnValue({
      streamId: BigInt(streamId),
      claimableAmount: '0',
      actionable: false,
      calculatedAt: now,
      cached: false,
    });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('No claimable balance is currently available');
  });

  it('does not double-count withdrawnAmount when the same claim window is withdrawn twice in a row', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 456;

    // Stateful in-memory representation of the Stream row. Rather than
    // stubbing each call with independent, hand-picked withdrawnAmount
    // values, this object is genuinely mutated by the mocked atomic
    // increment below (mirroring the real
    // `UPDATE "Stream" SET "withdrawnAmount" = withdrawnAmount + $1 ...`
    // SQL), so the second withdraw call's re-fetch actually observes
    // whatever the first call did.
    const streamState = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '100',
      depositedAmount: '10000000',
      withdrawnAmount: '0',
      startTime: Math.floor(Date.now() / 1000) - 5000,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 5000,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

    // Mock the claimable service to always return a positive claimable
    // amount, so the handler doesn't 409 on the second request.
    // Use a fixed amount so both requests compute the same claimable.
    mockClaimable.getClaimableAmount.mockReturnValue({
      streamId: BigInt(streamId),
      claimableAmount: '50000',
      actionable: true,
      calculatedAt: Math.floor(Date.now() / 1000),
      cached: false,
    });

    // Restore the plain pass-through $transaction implementation: an earlier
    // test in this file (the "successful withdraw" case) replaces it with a
    // custom implementation that queues a one-off findUnique() stub, which
    // vi.clearAllMocks() does not undo (it clears call history, not custom
    // implementations). Without this reset, that stale stub would leak into
    // this test's re-fetch.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    // Both the handler's initial read and the transaction's post-increment
    // re-read go through this, always reflecting the *current* state.
    mockPrisma.stream.findUnique.mockImplementation(async () => ({ ...streamState }));

    // Track which transactionHashes have already been inserted.
    // The INSERT uses WHERE NOT EXISTS + RETURNING, so the mock returns
    // row count 1 for a new event and 0 for a duplicate — mimicking the
    // real Postgres behaviour on the unique (transactionHash, eventType).
    const insertedHashes = new Set<string>();
    mockPrisma.$executeRawUnsafe.mockImplementation(
      async (sql: string, ..._args: unknown[]) => {
        if (sql.includes('INSERT INTO "StreamEvent"')) {
          // Extract the transactionHash ($3 arg) from the parameter list.
          // For this mock the args are positional: streamId, amount, txHash, now, metadata
          const txHashArg = _args[2] as string | undefined;
          if (txHashArg && insertedHashes.has(txHashArg)) {
            return 0; // duplicate — WHERE NOT EXISTS fails, RETURNING yields nothing
          }
          if (txHashArg) insertedHashes.add(txHashArg);
          return 1; // new event inserted
        }
        // Balance UPDATE: apply the atomic increment
        const withdrawAmountStr = _args[0] as string;
        const lastUpdateTime = _args[1] as bigint;
        streamState.withdrawnAmount = (
          BigInt(streamState.withdrawnAmount) + BigInt(withdrawAmountStr)
        ).toString();
        streamState.lastUpdateTime = Number(lastUpdateTime);
        return undefined;
      },
    );

    mockPrisma.stream.update.mockImplementation(async ({ data }: any) => {
      Object.assign(streamState, data);
      return { ...streamState };
    });

    // Both calls use the same deterministic hash (based on streamId),
    // so the second INSERT will be rejected by the unique constraint.
    mockWithdraw.mockResolvedValue({ txHash: `simulated-withdraw-${streamId}` });

    // --- First withdraw: claims the claimed 50000 amount ---
    const first = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    const firstClaimed = BigInt(first.body.amount);
    expect(firstClaimed).toBe(50000n);
    expect(first.body.stream.withdrawnAmount).toBe('50000');

    const withdrawnAfterFirst = streamState.withdrawnAmount;

    // --- Second withdraw, immediately after, for the SAME stream/recipient ---
    // The deterministic txHash means the event INSERT will be a no-op,
    // and the balance UPDATE will NOT run.
    const second = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    // The duplicate request is accepted (idempotent) — returning 200 with
    // the current state so the client can confirm the withdrawal was applied.
    expect(second.status).toBe(200);

    // Critical: withdrawnAmount must NOT have increased on the duplicate.
    // The balance is exactly what it was after the first legitimate claim.
    const withdrawnAfterSecond = streamState.withdrawnAmount;
    expect(BigInt(withdrawnAfterSecond)).toBe(BigInt(withdrawnAfterFirst));

    // The amount in the response still reflects the original claimable
    // calculation (handler always computes and returns it), but the
    // underlying balance was not touched.
    expect(second.body.stream.withdrawnAmount).toBe(withdrawnAfterFirst);

    // sorobanWithdraw is still called on every request (it validates the
    // claim is possible on-chain); the idempotency gate is at the DB level.
    expect(mockWithdraw).toHaveBeenCalledTimes(2);
  });

  it('gates balance increment on event INSERT rowcount — proves duplicate events skip the UPDATE', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 789;
    const streamState = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '100',
      depositedAmount: '10000000',
      withdrawnAmount: '0',
      startTime: Math.floor(Date.now() / 1000) - 1000,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 1000,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

    // Mock the claimable service to always return a positive claimable amount.
    mockClaimable.getClaimableAmount.mockReturnValue({
      streamId: BigInt(streamId),
      claimableAmount: '100000',
      actionable: true,
      calculatedAt: Math.floor(Date.now() / 1000),
      cached: false,
    });

    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.stream.findUnique.mockImplementation(async () => ({ ...streamState }));
    mockPrisma.stream.update.mockImplementation(async ({ data }: any) => {
      Object.assign(streamState, data);
      return { ...streamState };
    });

    // Track INSERT row counts across both requests.
    const insertRowCounts: number[] = [];
    const insertedHashes = new Set<string>();
    mockPrisma.$executeRawUnsafe.mockImplementation(
      async (sql: string, ...args: unknown[]) => {
        if (sql.includes('INSERT INTO "StreamEvent"')) {
          const txHashArg = args[2] as string | undefined;
          const rowcount = txHashArg && insertedHashes.has(txHashArg) ? 0 : 1;
          if (txHashArg && rowcount === 1) insertedHashes.add(txHashArg);
          insertRowCounts.push(rowcount);
          return rowcount;
        }
        // Balance UPDATE
        const amount = args[0] as string;
        const ts = args[1] as bigint;
        streamState.withdrawnAmount = (
          BigInt(streamState.withdrawnAmount) + BigInt(amount)
        ).toString();
        streamState.lastUpdateTime = Number(ts);
        return undefined;
      },
    );

    mockWithdraw.mockResolvedValue({ txHash: `simulated-withdraw-${streamId}` });

    // --- First request: INSERT rowcount = 1 → UPDATE runs ---
    const first = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(insertRowCounts[0]).toBe(1);

    // --- Second request (same txHash): INSERT rowcount = 0 → UPDATE skipped ---
    const second = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(200);
    expect(insertRowCounts[1]).toBe(0);

    // Balance must reflect only the first withdrawal.
    const finalBalance = BigInt(streamState.withdrawnAmount);
    expect(finalBalance).toBeGreaterThan(0n);
    // A second withdrawal would have doubled it; verify it didn't.
    expect(finalBalance).toBeLessThan(BigInt(first.body.amount) * 2n);

    // Verify the event INSERT was attempted twice (once per request)
    expect(insertRowCounts).toHaveLength(2);
  });
});
