import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';

const {
  mockWithdraw,
  mockPrisma,
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
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
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
    mockWithdraw.mockResolvedValue({ txHash: 'withdraw-tx-hash' });
    // Mock $transaction to simulate the withdraw handler's transaction
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      // After $executeRawUnsafe, the handler re-reads the stream
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
    
    // Verify the atomic SQL increment was called
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();

    // Verify event creation
    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'WITHDRAWN',
          streamId: BigInt(streamId),
          transactionHash: 'withdraw-tx-hash',
        }),
      })
    );
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
    const nowSec = Math.floor(Date.now() / 1000);

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
      startTime: nowSec - 5000,
      lastUpdateTime: nowSec - 5000, // 5000s of unclaimed accrual
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

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

    // Simulates the handler's atomic SQL increment:
    // UPDATE "Stream" SET "withdrawnAmount" = withdrawnAmount + $1, "lastUpdateTime" = $2
    mockPrisma.$executeRawUnsafe.mockImplementation(
      async (_sql: string, withdrawAmountStr: string, lastUpdateTime: bigint) => {
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

    let sorobanCallCount = 0;
    mockWithdraw.mockImplementation(async () => {
      sorobanCallCount += 1;
      return { txHash: `withdraw-tx-hash-${sorobanCallCount}` };
    });

    // --- First withdraw: claims the full ~5000s * 100/s accrued window ---
    const first = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    const firstClaimed = BigInt(first.body.amount);
    // Allow a little slack for real wall-clock time elapsed while the test
    // was setting up / the request was in flight.
    expect(firstClaimed).toBeGreaterThanOrEqual(499000n);
    expect(first.body.stream.withdrawnAmount).toBe(firstClaimed.toString());

    // --- Second withdraw, immediately after, for the SAME stream/recipient ---
    const second = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    const totalWithdrawn = BigInt(streamState.withdrawnAmount);

    if (second.status === 200) {
      // Some real wall-clock time may legitimately have elapsed between the
      // two requests, so a small additional claim on top of the first is
      // acceptable — but it must be nowhere near a second full claim of the
      // already-withdrawn window (which would indicate double-counting).
      const secondClaimed = BigInt(second.body.amount);
      expect(secondClaimed).toBeLessThan(firstClaimed / 10n);
    } else {
      // No meaningful time has elapsed since the first withdraw bumped
      // lastUpdateTime, so the second call correctly finds nothing left to
      // claim in this window and is rejected.
      expect(second.status).toBe(409);
      expect(second.body.message).toBe('No claimable balance is currently available');
    }

    // The critical assertion: withdrawnAmount reflects only the ONE
    // legitimate claim of the accrued window (plus, at most, a negligible
    // sliver of genuinely new accrual) — never a second full claim of the
    // same already-withdrawn window.
    expect(totalWithdrawn).toBeGreaterThanOrEqual(firstClaimed);
    expect(totalWithdrawn).toBeLessThan(firstClaimed * 2n);

    // sorobanWithdraw should only ever have been invoked once per HTTP call
    // (i.e. the second call didn't silently no-op withdraw on-chain either).
    expect(mockWithdraw).toHaveBeenCalledTimes(second.status === 200 ? 2 : 1);
  });
});
