import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';

const {
  mockPauseStream,
  mockResumeStream,
  mockWithdrawStream,
  mockPrisma,
} = vi.hoisted(() => ({
  mockPauseStream: vi.fn(),
  mockResumeStream: vi.fn(),
  mockWithdrawStream: vi.fn(),
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
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

vi.mock('../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../src/services/sorobanService.js', () => ({
  getStreamFromChain: vi.fn().mockResolvedValue(null),
  getClaimableFromChain: vi.fn().mockResolvedValue(null),
  isStale: vi.fn().mockReturnValue(false),
  pauseStream: mockPauseStream,
  resumeStream: mockResumeStream,
  withdrawStream: mockWithdrawStream,
}));

import app from '../../src/app.js';

function makeKeypair() {
  return StellarSdk.Keypair.random();
}

function buildSignedTransaction(keypair: StellarSdk.Keypair, nonce: string): string {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.manageData({
        name: 'auth',
        value: Buffer.from(nonce, 'hex'),
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

async function getValidJwt(keypair: StellarSdk.Keypair): Promise<string> {
  // The pause/resume/withdraw routes are guarded by authMiddleware, which
  // verifies a signed Stellar transaction envelope directly (not the JWT
  // issued by /v1/auth/verify). Build a fresh signed envelope each call so
  // the request supplies a valid bearer token.
  const nonce = '00'.repeat(32);
  return buildSignedTransaction(keypair, nonce);
}

describe('stream action routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.stream.findMany.mockResolvedValue([]);
    mockPrisma.stream.count.mockResolvedValue(0);
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);
    mockPrisma.streamEvent.count.mockResolvedValue(0);
  });

  it('POST /v1/streams/:streamId/pause pauses an active sender-owned stream', async () => {
    const sender = makeKeypair();
    const token = await getValidJwt(sender);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 7,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
    });
    mockPauseStream.mockResolvedValue({ txHash: 'pause-tx-hash' });
    mockPrisma.stream.update.mockResolvedValue({
      streamId: 7,
      isActive: true,
      isPaused: true,
      pausedAt: 1700000000,
      totalPausedDuration: 0,
    });

    const response = await request(app)
      .post('/v1/streams/7/pause')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId: 7,
      txHash: 'pause-tx-hash',
    });
    expect(mockPauseStream).toHaveBeenCalledWith(sender.publicKey(), 7);
    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 7 },
        data: expect.objectContaining({
          isPaused: true,
        }),
      }),
    );
    expect(mockPrisma.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'PAUSED',
          transactionHash: 'pause-tx-hash',
        }),
      }),
    );
  });

  it('POST /v1/streams/:streamId/resume resumes a paused sender-owned stream', async () => {
    const sender = makeKeypair();
    const token = await getValidJwt(sender);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 9,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: true,
      pausedAt: Math.floor(Date.now() / 1000) - 30,
      totalPausedDuration: 10,
    });
    mockResumeStream.mockResolvedValue({ txHash: 'resume-tx-hash' });
    mockPrisma.stream.update.mockResolvedValue({
      streamId: 9,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 40,
    });

    const response = await request(app)
      .post('/v1/streams/9/resume')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId: 9,
      txHash: 'resume-tx-hash',
    });
    expect(mockResumeStream).toHaveBeenCalledWith(sender.publicKey(), 9);
    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 9 },
        data: expect.objectContaining({
          isPaused: false,
        }),
      }),
    );
    expect(mockPrisma.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'RESUMED',
          transactionHash: 'resume-tx-hash',
        }),
      }),
    );
  });

  it('POST /v1/streams/:streamId/withdraw withdraws the claimable amount for the recipient', async () => {
    const recipient = makeKeypair();
    const token = await getValidJwt(recipient);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 11,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: Math.floor(Date.now() / 1000) - 50,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 10,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    });
    mockWithdrawStream.mockResolvedValue({ txHash: 'withdraw-tx-hash' });
    mockPrisma.stream.update.mockResolvedValue({
      streamId: 11,
      withdrawnAmount: '600',
      isActive: true,
    });

    const response = await request(app)
      .post('/v1/streams/11/withdraw')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId: 11,
      txHash: 'withdraw-tx-hash',
      amount: '100',
    });
    expect(mockWithdrawStream).toHaveBeenCalledWith(recipient.publicKey(), 11);
    expect(mockPrisma.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'WITHDRAWN',
          amount: '100',
          transactionHash: 'withdraw-tx-hash',
        }),
      }),
    );
  });
});
