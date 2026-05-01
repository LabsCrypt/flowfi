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
    },
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

vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { publicKey: currentUser.publicKey };
    next();
  },
}));

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
    mockPrisma.stream.update.mockResolvedValue({
      ...stream,
      withdrawnAmount: '200',
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
    expect(mockWithdraw).toHaveBeenCalledWith(streamId, recipient.publicKey());
    
    // Verify DB update
    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId },
        data: expect.objectContaining({
          withdrawnAmount: expect.any(String),
        }),
      })
    );

    // Verify event creation
    expect(mockPrisma.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'WITHDRAWN',
          streamId,
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
});
