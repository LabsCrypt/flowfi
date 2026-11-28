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
    mockWithdraw.mockResolvedValue({ simulated: true, fn: 'withdraw' });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    // Issue #1847: a simulation must announce itself and must not hand back a
    // placeholder hash that looks like a real transaction.
    expect(response.body).toMatchObject({
      success: true,
      simulated: true,
      streamId,
    });
    expect(response.body.txHash).toBeUndefined();

    // Verify service call with new signature (streamId, recipientAddress)
    expect(mockWithdraw).toHaveBeenCalledWith(BigInt(streamId), recipient.publicKey());

    // No accounting is written by a dry run: the indexer owns `withdrawnAmount`
    // and WITHDRAWN events, because only a confirmed event proves funds moved.
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
    expect(mockPrisma.streamEvent.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.streamEvent.create).not.toHaveBeenCalled();
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
    expect(response.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the stream recipient can withdraw from the stream',
    });
  });

  it('returns 404 if stream not found', async () => {
    const user = makeKeypair();
    const token = setAuthAs(user);

    mockPrisma.stream.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post('/v1/streams/999/withdraw')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Stream not found',
    });
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
    expect(response.body.error.message).toBe('No claimable balance is currently available');
  });

  it('never touches withdrawnAmount, isActive or events, however often it is called', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 456;
    const nowSec = Math.floor(Date.now() / 1000);

    // The row as the indexer last wrote it. Nothing here may change, because
    // the route only simulates (issue #1847).
    const streamState = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '100',
      depositedAmount: '10000000',
      withdrawnAmount: '0',
      startTime: nowSec - 5000,
      lastUpdateTime: nowSec - 5000,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

    // Mock the claimable service explicitly: vi.clearAllMocks() clears call
    // history but not return values, so the 409 case's actionable:false would
    // otherwise leak into this test.
    mockClaimable.getClaimableAmount.mockReturnValue({
      streamId: BigInt(streamId),
      claimableAmount: '50000',
      actionable: true,
      calculatedAt: nowSec,
      cached: false,
    });

    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.stream.findUnique.mockImplementation(async () => ({ ...streamState }));
    mockPrisma.stream.update.mockImplementation(async ({ data }: any) => {
      Object.assign(streamState, data);
      return { ...streamState };
    });
    // The route is a read-only simulation (issue #1847): it never executes raw
    // SQL, so no INSERT/UPDATE rowcount needs emulating here. A call would be
    // caught by the `not.toHaveBeenCalled()` assertions below.
    // The old stub returned one placeholder hash for every call, which is how
    // the second WITHDRAWN event was silently swallowed by the upsert key.
    mockWithdraw.mockResolvedValue({ simulated: true, fn: 'withdraw' });

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        request(app)
          .post(`/v1/streams/${streamId}/withdraw`)
          .set('Authorization', `Bearer ${token}`),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.simulated).toBe(true);
      expect(response.body.txHash).toBeUndefined();
    }

    // The double-count the placeholder hash used to create is now impossible:
    // three calls leave the accounting exactly where the indexer put it.
    expect(streamState.withdrawnAmount).toBe('0');
    expect(streamState.isActive).toBe(true);
    expect(streamState.lastUpdateTime).toBe(nowSec - 5000);
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
    expect(mockPrisma.streamEvent.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.streamEvent.create).not.toHaveBeenCalled();
  });

  it('reports the same claimable window to a recipient who retries, instead of a second claim', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 789;
    const nowSec = Math.floor(Date.now() / 1000);
    const stream = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '100',
      depositedAmount: '10000000',
      withdrawnAmount: '0',
      startTime: nowSec - 5000,
      lastUpdateTime: nowSec - 5000,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };
    mockPrisma.stream.findUnique.mockResolvedValue(stream);
    // Same 5000s * 100/s window the stream was seeded with; the route reports
    // it without consuming it, so a retry sees the same amount.
    mockClaimable.getClaimableAmount.mockReturnValue({
      streamId: BigInt(streamId),
      claimableAmount: '500000',
      actionable: true,
      calculatedAt: nowSec,
      cached: false,
    });
    mockWithdraw.mockResolvedValue({ simulated: true, fn: 'withdraw' });

    const first = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Both answers describe the same unclaimed window; the first did not
    // consume it, so a retry is a harmless read rather than a lost claim.
    expect(BigInt(second.body.amount)).toBeGreaterThanOrEqual(BigInt(first.body.amount));
    expect(BigInt(first.body.amount)).toBeGreaterThanOrEqual(499000n);
  });
});
