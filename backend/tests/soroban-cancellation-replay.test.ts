import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';

const { mockPrismaObj, mockSseBroadcastToStream } = vi.hoisted(() => ({
  mockSseBroadcastToStream: vi.fn(),
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
    broadcastToStream: mockSseBroadcastToStream,
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

const mockMapEntry = (key: string, val: any) => ({ key: mockSym(key), val });

describe('Issue #1762 - Cancellation Event Replay and Withdrawn-Balance Reconciliation', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventWorker();
  });

  const createCancellationEvent = (
    streamId: number | bigint,
    amountWithdrawn: string,
    refundedAmount: string,
    txHash = 'tx-cancel-hash-1',
    ledger = 2050,
    closedAt = '1772366400'
  ): rpc.Api.EventResponse => ({
    id: `ev-cancel-${streamId}`,
    type: 'contract',
    ledger,
    ledgerClosedAt: closedAt,
    txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [mockSym('stream_cancelled'), mockU64(streamId)],
    value: {
      map: [
        mockMapEntry('amount_withdrawn', mockI128(0, amountWithdrawn)),
        mockMapEntry('refunded_amount', mockI128(0, refundedAmount)),
      ],
    } as any,
  });

  describe('First-time cancellation event processing', () => {
    it('sets stream inactive, sets authoritative withdrawn amount, creates StreamEvent and emits SSE', async () => {
      const streamId = 501n;
      const txHash = 'tx-cancel-first';
      const event = createCancellationEvent(streamId, '350', '650', txHash, 2100);

      const mockTx = {
        stream: {
          update: vi.fn().mockResolvedValue({ streamId, isActive: false, withdrawnAmount: '350' }),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null), // First time: not present
          upsert: vi.fn().mockResolvedValue({ id: 'event-cancel-501' }),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleStreamCancelled(event, event.topic![1]);

      // Verifies stream updated to inactive with authoritative withdrawn amount
      expect(mockTx.stream.update).toHaveBeenCalledWith({
        where: { streamId },
        data: {
          isActive: false,
          withdrawnAmount: '350',
          lastUpdateTime: Number(event.ledgerClosedAt),
        },
      });

      // Verifies StreamEvent findUnique checked
      expect(mockTx.streamEvent.findUnique).toHaveBeenCalledWith({
        where: {
          transactionHash_eventType: {
            transactionHash: txHash,
            eventType: 'CANCELLED',
          },
        },
        select: { id: true },
      });

      // No duplicate warning on first call
      expect(logger.warn).not.toHaveBeenCalled();

      // Upsert called with creation data
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledWith({
        where: {
          transactionHash_eventType: {
            transactionHash: txHash,
            eventType: 'CANCELLED',
          },
        },
        create: expect.objectContaining({
          streamId,
          eventType: 'CANCELLED',
          amount: '650',
          transactionHash: txHash,
          ledgerSequence: 2100,
          metadata: JSON.stringify({ amountWithdrawn: '350', refundedAmount: '650' }),
        }),
        update: expect.objectContaining({
          ledgerSequence: 2100,
          amount: '650',
          metadata: JSON.stringify({ amountWithdrawn: '350', refundedAmount: '650' }),
        }),
      });

      // SSE event broadcast
      expect(mockSseBroadcastToStream).toHaveBeenCalledWith(
        String(streamId),
        'stream.cancelled',
        expect.objectContaining({
          streamId,
          amountWithdrawn: '350',
          refundedAmount: '650',
          transactionHash: txHash,
          ledger: 2100,
        })
      );
    });
  });

  describe('Replay and reconciliation of cancellation events', () => {
    it('reconciles existing provisional StreamEvent with authoritative on-chain details and logs warning', async () => {
      const streamId = 502n;
      const txHash = 'tx-provisional-cancel';
      const event = createCancellationEvent(streamId, '400', '600', txHash, 2200);

      const mockTx = {
        stream: {
          update: vi.fn().mockResolvedValue({ streamId, isActive: false, withdrawnAmount: '400' }),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'provisional-event-id' }), // Already exists!
          upsert: vi.fn().mockResolvedValue({ id: 'provisional-event-id' }),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleStreamCancelled(event, event.topic![1]);

      // Reconciles with warning log
      expect(logger.warn).toHaveBeenCalledWith(
        `[SorobanWorker] Reconciling existing StreamEvent: txHash=${txHash} type=CANCELLED`
      );

      // Replaces provisional fields with authoritative ledger details in upsert update
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledWith({
        where: {
          transactionHash_eventType: {
            transactionHash: txHash,
            eventType: 'CANCELLED',
          },
        },
        create: expect.any(Object),
        update: {
          ledgerSequence: 2200,
          timestamp: Number(event.ledgerClosedAt),
          amount: '600',
          metadata: JSON.stringify({ amountWithdrawn: '400', refundedAmount: '600' }),
        },
      });

      // Reconciles withdrawnAmount on the stream
      expect(mockTx.stream.update).toHaveBeenCalledWith({
        where: { streamId },
        data: expect.objectContaining({
          isActive: false,
          withdrawnAmount: '400',
        }),
      });
    });

    it('reconciles withdrawn balance without double-counting on multiple replays', async () => {
      const streamId = 503n;
      const txHash = 'tx-idempotent-replay';
      const event = createCancellationEvent(streamId, '750', '250', txHash, 2300);

      const mockTx = {
        stream: {
          update: vi.fn().mockResolvedValue({ streamId, isActive: false, withdrawnAmount: '750' }),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-event-id' }),
          upsert: vi.fn().mockResolvedValue({ id: 'existing-event-id' }),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      // Replay 1
      await (worker as any).handleStreamCancelled(event, event.topic![1]);

      // Replay 2
      await (worker as any).handleStreamCancelled(event, event.topic![1]);

      // Both calls should set withdrawnAmount to exact value ('750'), never an increment
      expect(mockTx.stream.update).toHaveBeenCalledTimes(2);
      expect(mockTx.stream.update).toHaveBeenNthCalledWith(1, {
        where: { streamId },
        data: expect.objectContaining({
          isActive: false,
          withdrawnAmount: '750',
        }),
      });
      expect(mockTx.stream.update).toHaveBeenNthCalledWith(2, {
        where: { streamId },
        data: expect.objectContaining({
          isActive: false,
          withdrawnAmount: '750',
        }),
      });
    });

    it('correctly reconciles zero-withdrawal cancellation (full refund)', async () => {
      const streamId = 504n;
      const txHash = 'tx-zero-withdrawn';
      const event = createCancellationEvent(streamId, '0', '10000', txHash, 2400);

      const mockTx = {
        stream: {
          update: vi.fn().mockResolvedValue({ streamId, isActive: false, withdrawnAmount: '0' }),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'existing-zero-event' }),
          upsert: vi.fn().mockResolvedValue({ id: 'existing-zero-event' }),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await (worker as any).handleStreamCancelled(event, event.topic![1]);

      expect(mockTx.stream.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { streamId },
          data: expect.objectContaining({
            isActive: false,
            withdrawnAmount: '0',
          }),
        })
      );

      expect(mockTx.streamEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            amount: '10000',
            metadata: JSON.stringify({ amountWithdrawn: '0', refundedAmount: '10000' }),
          }),
        })
      );
    });
  });

  describe('Error handling and missing fields', () => {
    it('throws when body fields are missing', async () => {
      const streamId = 505n;
      const event: rpc.Api.EventResponse = {
        id: 'ev-bad-cancel',
        type: 'contract',
        ledger: 2500,
        ledgerClosedAt: '2026-03-01T12:00:00Z',
        txHash: 'tx-missing-body',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_cancelled'), mockU64(streamId)],
        value: { map: [] } as any, // Missing amount_withdrawn and refunded_amount
      };

      await expect(
        (worker as any).handleStreamCancelled(event, event.topic![1])
      ).rejects.toThrow(`StreamCancelled #${streamId}: missing body fields`);
    });

    it('propagates database update failure when stream does not exist', async () => {
      const streamId = 999999n;
      const event = createCancellationEvent(streamId, '100', '100');

      const p2025Error = Object.assign(new Error('Record to update not found.'), {
        code: 'P2025',
      });

      const mockTx = {
        stream: {
          update: vi.fn().mockRejectedValue(p2025Error),
        },
      };

      mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));

      await expect(
        (worker as any).handleStreamCancelled(event, event.topic![1])
      ).rejects.toThrow('Record to update not found.');
    });
  });
});
