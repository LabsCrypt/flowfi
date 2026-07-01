import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { SorobanEventWorker } from '../../src/workers/soroban-event-worker.js';

const { mockPauseStream, mockResumeStream, mockPrisma } = vi.hoisted(() => ({
  mockPauseStream: vi.fn(),
  mockResumeStream: vi.fn(),
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      // Mock the transaction client as mockPrisma itself
      return cb(mockPrisma);
    }),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../src/services/sorobanService.js', () => ({
  pauseStream: mockPauseStream,
  resumeStream: mockResumeStream,
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
  const challengeRes = await request(app)
    .post('/v1/auth/challenge')
    .send({ publicKey: keypair.publicKey() });

  const nonce = challengeRes.body.nonce as string;
  const signedTransaction = buildSignedTransaction(keypair, nonce);

  const verifyRes = await request(app)
    .post('/v1/auth/verify')
    .send({ publicKey: keypair.publicKey(), signedTransaction });

  return verifyRes.body.token as string;
}

describe('Regression #804: Pause/resume controller duplicate StreamEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pauses a stream and only writes one PAUSED event via indexer', async () => {
    const sender = makeKeypair();
    const token = await getValidJwt(sender);
    const streamId = 77;

    // 1. Controller flow
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: sender.publicKey(),
      isActive: true,
      isPaused: false,
    });
    mockPauseStream.mockResolvedValue({ txHash: 'simulated-pause-77' });

    const pauseRes = await request(app)
      .post(`/v1/streams/${streamId}/pause`)
      .set('Authorization', `Bearer ${token}`);

    expect(pauseRes.status).toBe(200);

    // Controller should NOT write to DB for PAUSED event
    expect(mockPrisma.streamEvent.create).not.toHaveBeenCalled();
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();

    // 2. Indexer flow
    const worker = new SorobanEventWorker();

    const mockEvent = {
      id: 'event1',
      ledger: 100,
      txHash: 'real-tx-hash',
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('stream_paused'),
        StellarSdk.nativeToScVal(streamId, { type: 'u64' }),
      ],
      value: StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('sender'),
          val: new StellarSdk.Address(sender.publicKey()).toScVal(),
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('paused_at'),
          val: StellarSdk.nativeToScVal(Math.floor(Date.now() / 1000), { type: 'u64' }),
        }),
      ]),
      inSuccessfulContractCall: true,
    } as any;

    mockPrisma.streamEvent.findUnique.mockResolvedValue(null);

    await worker.processEvent(mockEvent);

    // Indexer should write exactly one PAUSED event
    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'PAUSED',
          transactionHash: 'real-tx-hash',
        }),
      }),
    );
    expect(mockPrisma.stream.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId },
        data: expect.objectContaining({ isPaused: true }),
      }),
    );
  });
});
