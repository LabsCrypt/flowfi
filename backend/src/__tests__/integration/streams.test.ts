import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { nativeToScVal, xdr, StrKey, Keypair } from '@stellar/stellar-sdk';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockPrisma, mockSseService } = vi.hoisted(() => ({
  mockSseService: {
    addClient: vi.fn(),
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
  },
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    streamEvent: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  }
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../../services/sse.service.js', () => ({
  sseService: mockSseService,
}));

// ─── App import (after mocks) ─────────────────────────────────────────────────

import app from '../../app.js';
import { sorobanEventWorker } from '../../workers/soroban-event-worker.js';

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDatabase('Stream Lifecycle Integration Tests', () => {
  const senderPair = Keypair.random();
  const recipientPair = Keypair.random();
  const sender = senderPair.publicKey();
  const recipient = recipientPair.publicKey();
  const tokenAddress = StrKey.encodeContract(Buffer.alloc(32));
  const streamId = 999;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Indexer processes stream_created event -> stream appears in GET /v1/streams/{id}', async () => {
    const event = {
      id: 'created-event-1',
      txHash: 'hash-created',
      ledger: 100,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_created'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('recipient'),
          val: nativeToScVal(recipient, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('token_address'),
          val: nativeToScVal(tokenAddress, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('rate_per_second'),
          val: nativeToScVal(BigInt(10), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('deposited_amount'),
          val: nativeToScVal(BigInt(1000), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('start_time'),
          val: nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        }),
      ]),
    } as any;

    const mockStream = {
      streamId,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    };

    mockPrisma.stream.findUnique.mockResolvedValue(mockStream);

    await sorobanEventWorker.processEvent(event);

    // Verify stream appears in GET API
    const res = await request(app).get(`/v1/streams/${streamId}`);
    expect(res.status).toBe(200);
    expect(res.body.streamId).toBe(streamId);
    expect(res.body.depositedAmount).toBe('1000');
  });

  it('Indexer processes stream_paused -> isPaused = true', async () => {
    const event = {
      id: 'paused-event-1',
      txHash: 'hash-paused',
      ledger: 102,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_paused'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('paused_at'),
          val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: 'u64' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId },
        data: expect.objectContaining({ isPaused: true }),
      })
    );
  });

  it('Indexer processes stream_resumed -> isPaused = false', async () => {
    const event = {
      id: 'resumed-event-1',
      txHash: 'hash-resumed',
      ledger: 103,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_resumed'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('new_end_time'),
          val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 60), { type: 'u64' }),
        }),
      ]),
    } as any;

    mockPrisma.stream.findUniqueOrThrow = vi.fn().mockResolvedValue({
      pausedAt: 1700000000,
      totalPausedDuration: 0,
    });

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId },
        data: expect.objectContaining({
          isPaused: false,
        }),
      }),
    );
  });

  it('Indexer processes stream_cancelled -> stream isActive = false', async () => {
    const event = {
      id: 'cancelled-event-1',
      txHash: 'hash-cancelled',
      ledger: 104,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_cancelled'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('amount_withdrawn'),
          val: nativeToScVal(BigInt(100), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('refunded_amount'),
          val: nativeToScVal(BigInt(900), { type: 'i128' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId },
        data: expect.objectContaining({ isActive: false }),
      }),
    );
  });

  it('GET /v1/streams/{id}/events returns events', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue({ streamId });
    mockPrisma.streamEvent.findMany.mockResolvedValue([
      { id: 'evt-1', eventType: 'CREATED', transactionHash: 'hash' }
    ]);
    mockPrisma.streamEvent.count.mockResolvedValue(1);

    const res = await request(app).get(`/v1/streams/${streamId}/events`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
  });
});
