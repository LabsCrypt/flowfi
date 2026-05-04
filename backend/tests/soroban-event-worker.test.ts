import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';

// Mock prisma before importing the worker
vi.mock('../src/lib/prisma.js', () => ({
  default: {
    indexerState: {
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    stream: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    streamEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb({ streamEvent: { findUnique: vi.fn(), upsert: vi.fn() }, user: { upsert: vi.fn() }, stream: { upsert: vi.fn(), update: vi.fn() } })),
    $disconnect: vi.fn(),
  },
  prisma: {
    indexerState: {
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    stream: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    streamEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb({ streamEvent: { findUnique: vi.fn(), upsert: vi.fn() }, user: { upsert: vi.fn() }, stream: { upsert: vi.fn(), update: vi.fn() } })),
    $disconnect: vi.fn(),
  },
}));

// Mock SSE service
vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
  },
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { prisma } from '../src/lib/prisma.js';
import logger from '../src/logger.js';

describe('SorobanEventWorker', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventWorker();

    // Mock the indexerState upsert for fetchAndProcessEvents
    (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'singleton',
      lastLedger: 0,
      lastCursor: null,
      updatedAt: new Date(),
    });
  });

  describe('Event processing idempotency', () => {
    it('should handle duplicate stream creation events (same txHash, eventType)', async () => {
      const eventId = 'test-event-123';
      const txHash = 'test-tx-hash-abc';
      const streamId = 42;

      // Create a mock event
      const mockEvent: rpc.Api.EventResponse = {
        id: eventId,
        type: 'contract',
        ledger: 1000,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          { switch: () => ({ value: 0 }), sym: () => 'stream_created' } as any,
          { switch: () => ({ value: 1 }), u64: () => ({ toString: () => streamId.toString() }) } as any,
        ],
        value: {
          switch: () => ({ value: 4 }),
          map: () => [
            { key: () => ({ sym: () => 'sender' }), val: () => ({ address: () => ({ switch: () => ({ value: 0 }), accountId: () => ({ ed25519: () => Buffer.alloc(32) }) }) }) },
            { key: () => ({ sym: () => 'recipient' }), val: () => ({ address: () => ({ switch: () => ({ value: 0 }), accountId: () => ({ ed25519: () => Buffer.alloc(32) }) }) }) },
            { key: () => ({ sym: () => 'token_address' }), val: () => ({ address: () => ({ switch: () => ({ value: 1 }), contractId: () => Buffer.alloc(32) }) }) },
            { key: () => ({ sym: () => 'rate_per_second' }), val: () => ({ i128: () => ({ hi: () => ({ toString: () => '0' }), lo: () => ({ toString: () => '100' }) }) }) },
            { key: () => ({ sym: () => 'deposited_amount' }), val: () => ({ i128: () => ({ hi: () => ({ toString: () => '0' }), lo: () => ({ toString: () => '86400' }) }) }) },
            { key: () => ({ sym: () => 'start_time' }), val: () => ({ u64: () => ({ toString: () => '1700000000' }) }) },
          ] as any,
        } as any,
      };

      // Setup transaction mock to track calls
      const mockTx = {
        user: {
          upsert: vi.fn().mockResolvedValue({ id: 'user-1', publicKey: 'GABC' }),
        },
        stream: {
          upsert: vi.fn().mockResolvedValue({ streamId, isActive: true }),
        },
        streamEvent: {
          findUnique: vi.fn(),
          upsert: vi.fn(),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // First call: event doesn't exist, should create
      mockTx.streamEvent.findUnique.mockResolvedValueOnce(null);
      mockTx.streamEvent.upsert.mockResolvedValueOnce({ id: 'event-1', transactionHash: txHash, eventType: 'CREATED' });

      // Process event first time
      await (worker as any).handleStreamCreated(mockEvent, mockEvent.topic![1]);
      expect(mockTx.streamEvent.findUnique).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.findUnique).toHaveBeenCalledWith({
        where: { transactionHash_eventType: { transactionHash: txHash, eventType: 'CREATED' } },
        select: { id: true },
      });
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      // Second call: event exists (duplicate), should skip with warning
      mockTx.streamEvent.findUnique.mockResolvedValueOnce({ id: 'event-1' });

      vi.clearAllMocks();
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Process same event again
      await (worker as any).handleStreamCreated(mockEvent, mockEvent.topic![1]);
      expect(mockTx.streamEvent.findUnique).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled(); // Should not create/upsert on duplicate
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate StreamEvent skipped')
      );
    });

    it('should handle duplicate fee collection events', async () => {
      const eventId = 'test-fee-event';
      const txHash = 'test-fee-tx-hash';
      const streamId = 99;

      const mockEvent: rpc.Api.EventResponse = {
        id: eventId,
        type: 'contract',
        ledger: 1000,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          { switch: () => ({ value: 0 }), sym: () => 'fee_collected' } as any,
          { switch: () => ({ value: 1 }), u64: () => ({ toString: () => streamId.toString() }) } as any,
        ],
        value: {
          switch: () => ({ value: 4 }),
          map: () => [
            { key: () => ({ sym: () => 'treasury' }), val: () => ({ address: () => ({ switch: () => ({ value: 0 }), accountId: () => ({ ed25519: () => Buffer.alloc(32) }) }) }) },
            { key: () => ({ sym: () => 'fee_amount' }), val: () => ({ i128: () => ({ hi: () => ({ toString: () => '0' }), lo: () => ({ toString: () => '1000' }) }) }) },
            { key: () => ({ sym: () => 'token' }), val: () => ({ address: () => ({ switch: () => ({ value: 1 }), contractId: () => Buffer.alloc(32) }) }) },
          ] as any,
        } as any,
      };

      // First call: event doesn't exist
      (prisma.streamEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      (prisma.streamEvent.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'fee-event-1',
        transactionHash: txHash,
        eventType: 'FEE_COLLECTED',
      });

      await (worker as any).handleFeeCollected(mockEvent, mockEvent.topic![1]);
      expect(prisma.streamEvent.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      // Reset mocks
      vi.clearAllMocks();

      // Second call: event exists (duplicate)
      (prisma.streamEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'fee-event-1',
      });

      await (worker as any).handleFeeCollected(mockEvent, mockEvent.topic![1]);
      expect(prisma.streamEvent.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate StreamEvent skipped')
      );
    });
  });
});
