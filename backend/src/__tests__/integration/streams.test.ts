import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { nativeToScVal, xdr, StrKey, Keypair } from '@stellar/stellar-sdk';
import app from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { sorobanEventWorker } from '../../workers/soroban-event-worker.js';
import { sseService } from '../../services/sse.service.js';

describe('Stream Lifecycle Integration Tests', () => {
  const senderPair = Keypair.random();
  const recipientPair = Keypair.random();
  const sender = senderPair.publicKey();
  const recipient = recipientPair.publicKey();
  const tokenAddress = StrKey.encodeContract(Buffer.alloc(32));
  const streamId = 999;
  let sseEvents: any[] = [];

  beforeAll(async () => {
    // Set up a test SSE client
    const mockRes = {
      write: (chunk: string) => {
        const lines = chunk.split('\n');
        let eventName = '';
        let data: any = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          if (line.startsWith('data: ')) {
            try {
              data = JSON.parse(line.slice(6).trim());
            } catch (e) {}
          }
        }
        if (eventName && data) {
          sseEvents.push({ event: eventName, data });
        }
      },
      on: () => {},
    } as any;

    sseService.addClient('test-integration-client', mockRes, ['*']);
    
    // Clean up DB before test
    await prisma.streamEvent.deleteMany({ where: { streamId } }).catch(() => {});
    await prisma.stream.deleteMany({ where: { streamId } }).catch(() => {});
  });

  afterAll(async () => {
    await prisma.streamEvent.deleteMany({ where: { streamId } }).catch(() => {});
    await prisma.stream.deleteMany({ where: { streamId } }).catch(() => {});
  });

  it('Indexer processes stream_created event -> stream appears in GET /v1/streams/{id}', async () => {
    sseEvents = [];
    
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
          val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: 'u64' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    // Verify stream appears in GET API
    const res = await request(app).get(`/v1/streams/${streamId}`);
    expect(res.status).toBe(200);
    expect(res.body.streamId).toBe(streamId);
    expect(res.body.depositedAmount).toBe('1000');
    
    // Verify SSE
    expect(sseEvents.some(e => e.event === 'stream.created')).toBe(true);
  });

  it('Indexer processes stream_topped_up -> depositedAmount updated in DB', async () => {
    sseEvents = [];

    const event = {
      id: 'topped-up-event-1',
      txHash: 'hash-topped-up',
      ledger: 101,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_topped_up'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('amount'),
          val: nativeToScVal(BigInt(500), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('new_deposited_amount'),
          val: nativeToScVal(BigInt(1500), { type: 'i128' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    const dbStream = await prisma.stream.findUnique({ where: { streamId } });
    expect(dbStream?.depositedAmount).toBe('1500');

    expect(sseEvents.some(e => e.event === 'stream.topped_up')).toBe(true);
  });

  it('Indexer processes stream_paused -> isPaused = true', async () => {
    sseEvents = [];

    const event = {
      id: 'paused-event-1',
      txHash: 'hash-paused',
      ledger: 102,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_paused'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    const dbStream = await prisma.stream.findUnique({ where: { streamId } });
    expect(dbStream?.isPaused).toBe(true);

    expect(sseEvents.some(e => e.event === 'stream.paused')).toBe(true);
  });

  it('Indexer processes stream_resumed -> isPaused = false', async () => {
    sseEvents = [];

    const event = {
      id: 'resumed-event-1',
      txHash: 'hash-resumed',
      ledger: 103,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_resumed'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    const dbStream = await prisma.stream.findUnique({ where: { streamId } });
    expect(dbStream?.isPaused).toBe(false);

    expect(sseEvents.some(e => e.event === 'stream.resumed')).toBe(true);
  });

  it('Indexer processes stream_cancelled -> stream isActive = false', async () => {
    sseEvents = [];

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
          val: nativeToScVal(BigInt(1400), { type: 'i128' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    const dbStream = await prisma.stream.findUnique({ where: { streamId } });
    expect(dbStream?.isActive).toBe(false);

    expect(sseEvents.some(e => e.event === 'stream.cancelled')).toBe(true);
  });

  it('GET /v1/streams/{id}/events returns all lifecycle events', async () => {
    const res = await request(app).get(`/v1/streams/${streamId}/events`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});
