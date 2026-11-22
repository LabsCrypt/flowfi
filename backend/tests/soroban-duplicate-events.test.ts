import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rpc, StrKey } from '@stellar/stellar-sdk';

const { mockPrismaObj } = vi.hoisted(() => ({
  mockPrismaObj: {
    indexerState: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    stream: {
      upsert: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    streamEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    indexerDeadLetterEvent: {
      upsert: vi.fn(),
    },
    ledgerCheckpoint: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn((cb) =>
      cb({
        streamEvent: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
        user: { upsert: vi.fn() },
        stream: { upsert: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
        $executeRaw: vi.fn().mockResolvedValue(1),
      })
    ),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  default: mockPrismaObj,
  prisma: mockPrismaObj,
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  requestContext: {
    run: vi.fn((_ctx, fn) => fn()),
    getStore: vi.fn(() => ({ correlationId: 'test-correlation-id' })),
  },
}));

vi.mock('../src/services/indexerService.js', () => ({
  publishIndexerLag: vi.fn().mockResolvedValue(undefined),
  quarantineEvent: vi.fn().mockResolvedValue(undefined),
}));

import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import logger from '../src/logger.js';

// ScVal mock helpers
const mockSym = (name: string) => ({ sym: { toString: () => name } } as any);
const mockU64 = (value: number | bigint | string) => ({ u64: { toString: () => String(value) } } as any);
const mockI128 = (hi: number | bigint | string, lo: number | bigint | string) => ({
  i128: { hi: { toString: () => String(hi) }, lo: { toString: () => String(lo) } },
} as any);

const mockAccountAddr = (pubKey = 'GBEVJL4RM4IIUHWMB6N2X2LDYV5XEXR7GHCJ2GZCHP3FHLREX3W2TIIY') => ({
  address: {
    type: 'scAddressTypeAccount',
    accountId: { ed25519: { value: StrKey.decodeEd25519PublicKey(pubKey) } },
  },
} as any);

const mockContractAddr = (hex = '00'.repeat(32)) => ({
  address: {
    type: 'scAddressTypeContract',
    contractId: { value: Buffer.from(hex, 'hex') },
  },
} as any);

const mockMapEntry = (key: string, val: any) => ({ key: mockSym(key), val });

describe('Issue #1758 - Duplicate Indexer Event Handling', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventWorker();

    mockPrismaObj.indexerState.findUnique.mockResolvedValue({
      id: 'singleton',
      lastLedger: 1000,
      lastCursor: null,
      updatedAt: new Date(),
    });
    mockPrismaObj.indexerState.upsert.mockResolvedValue({
      id: 'singleton',
      lastLedger: 1000,
      lastCursor: null,
      updatedAt: new Date(),
    });
  });

  describe('Duplicate event delivery across lifecycle event types', () => {
    it('skips duplicate stream_created and logs warning without modifying stream', async () => {
      const txHash = 'tx-create-duplicate';
      const streamId = 101;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'ev-create-1',
        type: 'contract',
        ledger: 1000,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_created'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('recipient', mockAccountAddr()),
            mockMapEntry('token_address', mockContractAddr()),
            mockMapEntry('rate_per_second', mockI128(0, 100)),
            mockMapEntry('deposited_amount', mockI128(0, 5000)),
            mockMapEntry('withdrawn_amount', mockI128(0, 0)),
            mockMapEntry('start_time', mockU64(1700000000)),
            mockMapEntry('is_active', { b: true } as any),
          ],
        } as any,
      };

      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({ id: 'u1' }) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId, isActive: true }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-create-event-id' }),
          upsert: vi.fn(),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleStreamCreated(mockEvent, mockEvent.topic![1]);

      expect(mockTx.streamEvent.findUnique).toHaveBeenCalledWith({
        where: {
          transactionHash_eventType: { transactionHash: txHash, eventType: 'CREATED' },
        },
        select: { id: true },
      });
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${txHash} type=CREATED`)
      );
    });

    it('skips duplicate stream_topped_up without double-incrementing depositedAmount or pushing endTime', async () => {
      const txHash = 'tx-topup-duplicate';
      const streamId = 102;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'ev-topup-1',
        type: 'contract',
        ledger: 1001,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_topped_up'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('amount', mockI128(0, 500)),
            mockMapEntry('new_deposited_amount', mockI128(0, 1500)),
          ],
        } as any,
      };

      const mockTx = {
        stream: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            streamId,
            depositedAmount: '1000',
            ratePerSecond: '10',
            startTime: 1700000000n,
            endTime: 1700000100n,
            totalPausedDuration: 0n,
          }),
          update: vi.fn(),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-topup-id', ledgerSequence: 1001 }),
          upsert: vi.fn(),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleStreamToppedUp(mockEvent, mockEvent.topic![1]);

      expect(mockTx.streamEvent.findUnique).toHaveBeenCalledWith({
        where: {
          transactionHash_eventType: { transactionHash: txHash, eventType: 'TOPPED_UP' },
        },
        select: { id: true, ledgerSequence: true },
      });
      expect(mockTx.stream.update).not.toHaveBeenCalled();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${txHash} type=TOPPED_UP`)
      );
    });

    it('skips duplicate tokens_withdrawn without double-incrementing withdrawnAmount', async () => {
      const txHash = 'tx-withdraw-duplicate';
      const streamId = 103;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'ev-withdraw-1',
        type: 'contract',
        ledger: 1002,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('tokens_withdrawn'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('recipient', mockAccountAddr()),
            mockMapEntry('amount', mockI128(0, 300)),
            mockMapEntry('timestamp', mockU64(1700000050)),
          ],
        } as any,
      };

      const mockTx = {
        stream: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            streamId,
            withdrawnAmount: '300',
          }),
          update: vi.fn(),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-withdraw-id' }),
          upsert: vi.fn(),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleTokensWithdrawn(mockEvent, mockEvent.topic![1]);

      expect(mockTx.stream.update).not.toHaveBeenCalled();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${txHash} type=WITHDRAWN`)
      );
    });

    it('skips duplicate stream_paused and stream_resumed without corrupting pause state', async () => {
      const txHashPause = 'tx-pause-duplicate';
      const streamId = 104;

      const mockPauseEvent: rpc.Api.EventResponse = {
        id: 'ev-pause-1',
        type: 'contract',
        ledger: 1003,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: txHashPause,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_paused'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('paused_at', mockU64(1700000060)),
          ],
        } as any,
      };

      const mockPauseTx = {
        stream: { update: vi.fn() },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-pause-id' }),
          upsert: vi.fn(),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockPauseTx));

      await (worker as any).handleStreamPaused(mockPauseEvent, mockPauseEvent.topic![1]);

      // stream.update sets idempotent state (isPaused: true, pausedAt)
      expect(mockPauseTx.stream.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: 104n },
          data: expect.objectContaining({ isPaused: true }),
        })
      );
      expect(mockPauseTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${txHashPause} type=PAUSED`)
      );

      // Now test stream_resumed duplicate
      const txHashResume = 'tx-resume-duplicate';
      const mockResumeEvent: rpc.Api.EventResponse = {
        id: 'ev-resume-1',
        type: 'contract',
        ledger: 1004,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: txHashResume,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_resumed'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('new_end_time', mockU64(1700000200)),
          ],
        } as any,
      };

      const mockResumeTx = {
        stream: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            streamId,
            pausedAt: 1700000060n,
            totalPausedDuration: 0,
          }),
          update: vi.fn(),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-resume-id' }),
          upsert: vi.fn(),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockResumeTx));

      await (worker as any).handleStreamResumed(mockResumeEvent, mockResumeEvent.topic![1]);

      // stream.update sets isPaused: false
      expect(mockResumeTx.stream.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: 104n },
          data: expect.objectContaining({ isPaused: false }),
        })
      );
      expect(mockResumeTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${txHashResume} type=RESUMED`)
      );
    });

    it('skips duplicate stream_completed events without writing duplicate StreamEvent rows', async () => {
      const txHash = 'tx-complete-duplicate';
      const streamId = 105;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'ev-complete-1',
        type: 'contract',
        ledger: 1005,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_completed'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('recipient', mockAccountAddr()),
            mockMapEntry('total_withdrawn', mockI128(0, 5000)),
          ],
        } as any,
      };

      const mockTx = {
        stream: { update: vi.fn() },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-complete-id' }),
          upsert: vi.fn(),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleStreamCompleted(mockEvent, mockEvent.topic![1]);

      // stream.update idempotently marks stream completed
      expect(mockTx.stream.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId: 105n },
          data: expect.objectContaining({ isActive: false }),
        })
      );
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${txHash} type=COMPLETED`)
      );
    });
  });

  describe('Unique constraint collision safety and idempotency', () => {
    it('handles unique constraint P2002 collision by relying on unique key', async () => {
      const p2002Error = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['transactionHash', 'eventType'] },
      });

      const txHash = 'tx-race-collision';
      const streamId = 106;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'ev-race-1',
        type: 'contract',
        ledger: 1006,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_created'), mockU64(streamId)],
        value: {
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('recipient', mockAccountAddr()),
            mockMapEntry('token_address', mockContractAddr()),
            mockMapEntry('rate_per_second', mockI128(0, 100)),
            mockMapEntry('deposited_amount', mockI128(0, 5000)),
            mockMapEntry('withdrawn_amount', mockI128(0, 0)),
            mockMapEntry('start_time', mockU64(1700000000)),
            mockMapEntry('is_active', { b: true } as any),
          ],
        } as any,
      };

      // In a race condition: findUnique saw null, but concurrent writer inserted right before
      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({ id: 'u1' }) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId, isActive: true }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockRejectedValueOnce(p2002Error),
        },
      };

      mockPrismaObj.$transaction.mockImplementation(async (cb: any) => {
        try {
          return await cb(mockTx);
        } catch (err: any) {
          if (err.code === 'P2002') {
            // Documented recovery: unique constraint prevented double write
            logger.warn(`[SorobanWorker] Concurrent P2002 caught for ${txHash}`);
            return;
          }
          throw err;
        }
      });

      await expect(
        (worker as any).handleStreamCreated(mockEvent, mockEvent.topic![1])
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Concurrent P2002 caught for ${txHash}`)
      );
    });

    it('advances batch cursor and checkpoint when batch contains duplicate deliveries', async () => {
      const duplicateTxHash = 'dup-tx-batch-1';

      const event1: rpc.Api.EventResponse = {
        id: 'cursor-1',
        type: 'contract',
        ledger: 1007,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: duplicateTxHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_paused'), mockU64(201n)],
        value: {
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('paused_at', mockU64(1700000100)),
          ],
        } as any,
      };

      // Duplicate delivery of the exact same event
      const event2: rpc.Api.EventResponse = {
        ...event1,
        id: 'cursor-2',
      };

      const mockTx = {
        stream: { update: vi.fn() },
        streamEvent: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(null) // First time: not present
            .mockResolvedValueOnce({ id: 'ev-created' }), // Second time: duplicate
          upsert: vi.fn().mockResolvedValue({ id: 'ev-created' }),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      (worker as any).server = {
        getEvents: vi.fn().mockResolvedValue({
          events: [event1, event2],
          latestLedger: 1007,
          cursor: 'cursor-2',
        }),
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1007 }),
      };

      await (worker as any).fetchAndProcessEvents();

      // Check that the duplicate was skipped with warning
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate StreamEvent skipped: txHash=${duplicateTxHash} type=PAUSED`)
      );

      // Verify that indexer state still cleanly updated to latest cursor
      expect(mockPrismaObj.indexerState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'singleton' },
          update: expect.objectContaining({ lastLedger: 1007 }),
        })
      );
    });
  });
});
