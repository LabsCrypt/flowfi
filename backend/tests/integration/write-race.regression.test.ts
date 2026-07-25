import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { SorobanEventWorker } from '../../src/workers/soroban-event-worker.js';

let dbEvents: any[] = [];

const { mockWithdraw, mockPrisma } = vi.hoisted(() => ({
  mockWithdraw: vi.fn(),
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    streamEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => cb(mockPrisma)),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../src/services/sorobanService.js', () => ({
  withdraw: mockWithdraw,
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: (global as any).TEST_RECIPIENT_PK };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

import app from '../../src/app.js';

describe('Controller-vs-Indexer StreamEvent Write Race Regression Test', () => {
  const recipientPk = StellarSdk.Keypair.random().publicKey();
  const senderPk = StellarSdk.Keypair.random().publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
    dbEvents = [];
    (global as any).TEST_RECIPIENT_PK = recipientPk;

    // Mock Prisma upsert implementation to behave like a real database upsert on unique constraint
    mockPrisma.streamEvent.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const { transactionHash, eventType } = where.transactionHash_eventType;
      console.log('MOCK UPSERT CALLED:', { transactionHash, eventType, create, update });
      const index = dbEvents.findIndex(
        (e) => e.transactionHash === transactionHash && e.eventType === eventType
      );

      if (index > -1) {
        console.log('MOCK UPSERT: Row found, updating index:', index);
        // Row exists, apply update
        dbEvents[index] = {
          ...dbEvents[index],
          ...update,
        };
        return dbEvents[index];
      } else {
        console.log('MOCK UPSERT: Row not found, creating new row');
        // Row does not exist, apply create
        const newEvent = {
          id: `evt-${Math.random()}`,
          ...create,
        };
        dbEvents.push(newEvent);
        return newEvent;
      }
    });

    mockPrisma.streamEvent.findUnique.mockImplementation(async ({ where }: any) => {
      const { transactionHash, eventType } = where.transactionHash_eventType;
      const found = dbEvents.find(
        (e) => e.transactionHash === transactionHash && e.eventType === eventType
      );
      return found || null;
    });
  });

  it('Scenario 1: Controller writes first (placeholders), then Worker upserts (real values)', async () => {
    const streamId = 123;
    const txHash = 'tx-hash-race-1';
    const now = Math.floor(Date.now() / 1000);

    // 1. Controller flow
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: senderPk,
      recipient: recipientPk,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: now - 100,
      lastUpdateTime: now - 50,
      isActive: true,
      isPaused: false,
    });
    mockWithdraw.mockResolvedValue({ txHash });
    mockPrisma.stream.update.mockResolvedValue({});

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', 'Bearer mock-token');

    expect(response.status).toBe(200);

    // Verify the controller inserted the event with placeholder values
    expect(dbEvents.length).toBe(1);
    expect(dbEvents[0]).toMatchObject({
      transactionHash: txHash,
      eventType: 'WITHDRAWN',
      ledgerSequence: 0, // Placeholder
    });

    // 2. Worker / Indexer flow
    const worker = new SorobanEventWorker();
    const mockEvent = {
      id: 'event1',
      ledger: 456, // Real ledger
      txHash,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('tokens_withdrawn'),
        StellarSdk.nativeToScVal(streamId, { type: 'u64' }),
      ],
      value: StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('recipient'),
          val: new StellarSdk.Address(recipientPk).toScVal(),
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
          val: StellarSdk.nativeToScVal(100, { type: 'i128' }),
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('timestamp'),
          val: StellarSdk.nativeToScVal(now, { type: 'u64' }),
        }),
      ]),
      inSuccessfulContractCall: true,
    } as any;

    mockPrisma.stream.findUniqueOrThrow.mockResolvedValue({ withdrawnAmount: '100' });

    // Run the worker handler for the event
    await (worker as any).handleTokensWithdrawn(mockEvent, mockEvent.topic[1]);

    // Verify worker didn't crash and updated the placeholder event to real sequence/timestamp
    expect(dbEvents.length).toBe(1); // Still only 1 event in total (no duplicate)
    console.log('FINAL STATE OF dbEvents IN SCENARIO 1:', dbEvents);
    expect(dbEvents[0]).toMatchObject({
      transactionHash: txHash,
      eventType: 'WITHDRAWN',
      ledgerSequence: 456, // Updated to real ledger!
      timestamp: now, // Updated to real timestamp!
    });
  });

  it('Scenario 2: Worker writes first (real values), then Controller upserts (update: {})', async () => {
    const streamId = 123;
    const txHash = 'tx-hash-race-2';
    const now = Math.floor(Date.now() / 1000);

    // 1. Worker writes first
    const worker = new SorobanEventWorker();
    const mockEvent = {
      id: 'event1',
      ledger: 789, // Real ledger
      txHash,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('tokens_withdrawn'),
        StellarSdk.nativeToScVal(streamId, { type: 'u64' }),
      ],
      value: StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('recipient'),
          val: new StellarSdk.Address(recipientPk).toScVal(),
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
          val: StellarSdk.nativeToScVal(100, { type: 'i128' }),
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('timestamp'),
          val: StellarSdk.nativeToScVal(now, { type: 'u64' }),
        }),
      ]),
      inSuccessfulContractCall: true,
    } as any;

    mockPrisma.stream.findUniqueOrThrow.mockResolvedValue({ withdrawnAmount: '100' });

    await (worker as any).handleTokensWithdrawn(mockEvent, mockEvent.topic[1]);

    expect(dbEvents.length).toBe(1);
    expect(dbEvents[0]).toMatchObject({
      transactionHash: txHash,
      eventType: 'WITHDRAWN',
      ledgerSequence: 789,
      timestamp: now,
    });

    // 2. Controller flow tries to write second
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: senderPk,
      recipient: recipientPk,
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: now - 100,
      lastUpdateTime: now - 50,
      isActive: true,
      isPaused: false,
    });
    mockWithdraw.mockResolvedValue({ txHash });
    mockPrisma.stream.update.mockResolvedValue({});

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', 'Bearer mock-token');

    // Verify controller returns 200 successful (didn't crash with P2002)
    expect(response.status).toBe(200);

    // Verify event details were NOT overwritten with placeholders
    expect(dbEvents.length).toBe(1);
    console.log('FINAL STATE OF dbEvents IN SCENARIO 2:', dbEvents);
    expect(dbEvents[0]).toMatchObject({
      transactionHash: txHash,
      eventType: 'WITHDRAWN',
      ledgerSequence: 789, // Retained real value!
      timestamp: now, // Retained real value!
    });
  });
});
