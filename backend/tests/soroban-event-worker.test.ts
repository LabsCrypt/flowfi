import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';

const mockPrismaObj = vi.hoisted(() => ({
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
  $transaction: vi.fn((cb) => cb({ streamEvent: { findUnique: vi.fn(), upsert: vi.fn() }, user: { upsert: vi.fn() }, stream: { upsert: vi.fn(), update: vi.fn() } })),
  $disconnect: vi.fn(),
}));

// Mock prisma before importing the worker
vi.mock('../src/lib/prisma.js', () => ({
  default: mockPrismaObj,
  prisma: mockPrismaObj,
}));

// Mock SSE service
vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

// Mock logger
vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  return {
    ...actual,
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { prisma } from '../src/lib/prisma.js';
import logger from '../src/logger.js';

// ─── ScVal v17 mock helpers (property-based, not method-based) ──────────────
const mockSym = (name: string) => ({ sym: { toString: () => name } } as any);
const mockU64 = (value: number | bigint | string) => ({ u64: { toString: () => String(value) } } as any);
const mockI128 = (hi: number | bigint | string, lo: number | bigint | string) => ({ i128: { hi: { toString: () => String(hi) }, lo: { toString: () => String(lo) } } } as any);
const mockAccountAddr = () => ({ address: { type: 'scAddressTypeAccount', accountId: { ed25519: { value: Buffer.alloc(32) } } } } as any);
const mockContractAddr = () => ({ address: { type: 'scAddressTypeContract', contractId: { value: Buffer.alloc(32) } } } as any);
const mockMapEntry = (keyName: string, val: any) => ({ key: mockSym(keyName), val } as any);
const mockMapValue = (entries: any[]) => ({ map: entries } as any);

/** Build a valid admin_transferred event (processes without throwing). */
function makeAdminTransferredEvent(
  id: string,
  ledger: number,
  txHash: string,
): rpc.Api.EventResponse {
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [mockSym('admin_transferred')],
    value: {
      type: 'scvMap',
      map: [
        mockMapEntry('previous_admin', mockAccountAddr()),
        mockMapEntry('new_admin', mockAccountAddr()),
      ] as any,
    } as any,
  };
}

/** Build a malformed fee_config_updated event (missing body fields → throws). */
function makeMalformedEvent(
  id: string,
  ledger: number,
  txHash: string,
): rpc.Api.EventResponse {
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [mockSym('fee_config_updated')],
    value: {
      type: 'scvMap',
      map: [] as any,
    } as any,
  };
}

// Standard stream fields map used across most tests
const streamFields = (overrides?: { withdrawn_amount?: string; isActive?: boolean; is_active_value?: boolean }) => [
  mockMapEntry('sender', mockAccountAddr()),
  mockMapEntry('recipient', mockAccountAddr()),
  mockMapEntry('token_address', mockContractAddr()),
  mockMapEntry('rate_per_second', mockI128(0, 100)),
  mockMapEntry('deposited_amount', mockI128(0, 86400)),
  mockMapEntry('withdrawn_amount', mockI128(0, Number(overrides?.withdrawn_amount ?? 0))),
  mockMapEntry('start_time', mockU64(1700000000)),
  mockMapEntry('is_active', { b: overrides?.is_active_value ?? true } as any),
];

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
          mockSym('stream_created'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          ...mockMapValue(streamFields()),
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

    it('should persist a zero-rate stream_created event without throwing', async () => {
      const txHash = 'zero-rate-tx-hash';
      const streamId = 77;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'zero-rate-event-1',
        type: 'contract',
        ledger: 2000,
        ledgerClosedAt: '2024-06-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('stream_created'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('recipient', mockAccountAddr()),
            mockMapEntry('token_address', mockContractAddr()),
            // rate_per_second = 0 (hi=0, lo=0)
            mockMapEntry('rate_per_second', mockI128('0', '0')),
            mockMapEntry('deposited_amount', mockI128('0', '500')),
            mockMapEntry('start_time', mockU64('1700000000')),
          ] as any,
        } as any,
      };

      let capturedStreamUpsert: any = null;
      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: {
          upsert: vi.fn().mockImplementation((args) => {
            capturedStreamUpsert = args;
            return Promise.resolve({ streamId, isActive: true });
          }),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: 'event-zero-rate' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Must not throw
      await expect(
        (worker as any).handleStreamCreated(mockEvent, mockEvent.topic![1])
      ).resolves.not.toThrow();

      // Stream was persisted
      expect(mockTx.stream.upsert).toHaveBeenCalledTimes(1);

      // endTime must be null — never computed via division
      expect(capturedStreamUpsert?.create?.endTime).toBeNull();

      // StreamEvent row was also persisted
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
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
          mockSym('fee_collected'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('treasury', mockAccountAddr()),
            mockMapEntry('fee_amount', mockI128('0', '1000')),
            mockMapEntry('token', mockContractAddr()),
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

    it('should process fee_config_updated events successfully', async () => {
      const txHash = 'fee-config-tx-hash';

      const mockEvent: rpc.Api.EventResponse = {
        id: 'fee-config-event-1',
        type: 'contract',
        ledger: 1005,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('fee_config_updated'),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('admin', mockAccountAddr()),
            mockMapEntry('old_treasury', mockAccountAddr()),
            mockMapEntry('new_treasury', mockAccountAddr()),
            mockMapEntry('old_fee_rate_bps', { u32: 100 } as any),
            mockMapEntry('new_fee_rate_bps', { u32: 200 } as any),
          ] as any,
        } as any,
      };

      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId: 0, isActive: false }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: 'event-fee-config' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Handle processEvent which will dispatch to handleFeeConfigUpdated
      await worker.processEvent(mockEvent);

      expect(mockTx.user.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.stream.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            streamId: 0n,
            eventType: 'FEE_CONFIG_UPDATED',
            transactionHash: txHash,
            ledgerSequence: 1005,
          }),
        })
      );
    });

    it('should replay a stream_paused event without duplicate rows or error', async () => {
      const txHash = 'pause-tx-hash';
      const streamId = 10;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'pause-event-1',
        type: 'contract',
        ledger: 3000,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('stream_paused'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('paused_at', mockU64('1700001000')),
          ] as any,
        } as any,
      };

      const mockTx = {
        stream: { update: vi.fn().mockResolvedValue({}) },
        streamEvent: {
          findUnique: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ id: 'pause-event-row' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // First replay: no existing event → should upsert
      mockTx.streamEvent.findUnique.mockResolvedValueOnce(null);
      await expect((worker as any).handleStreamPaused(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      vi.clearAllMocks();
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Second replay: event already exists → should skip with warning, no upsert
      mockTx.streamEvent.findUnique.mockResolvedValueOnce({ id: 'pause-event-row' });
      await expect((worker as any).handleStreamPaused(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate StreamEvent skipped'));
    });

    it('should replay a stream_resumed event without duplicate rows or error', async () => {
      const txHash = 'resume-tx-hash';
      const streamId = 11;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'resume-event-1',
        type: 'contract',
        ledger: 3001,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('stream_resumed'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('sender', mockAccountAddr()),
            mockMapEntry('new_end_time', mockU64('1700090000')),
          ] as any,
        } as any,
      };

      const mockTx = {
        stream: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ pausedAt: 1700001000, totalPausedDuration: 0 }),
          update: vi.fn().mockResolvedValue({}),
        },
        streamEvent: {
          findUnique: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ id: 'resume-event-row' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // First replay: no existing event → should upsert
      mockTx.streamEvent.findUnique.mockResolvedValueOnce(null);
      await expect((worker as any).handleStreamResumed(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mockTx.stream.findUniqueOrThrow.mockResolvedValue({ pausedAt: 1700001000, totalPausedDuration: 0 });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Second replay: event already exists → should skip with warning, no upsert
      mockTx.streamEvent.findUnique.mockResolvedValueOnce({ id: 'resume-event-row' });
      await expect((worker as any).handleStreamResumed(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate StreamEvent skipped'));
    });

    it('should not double-increment withdrawnAmount when a tokens_withdrawn event is re-processed', async () => {
      const txHash = 'withdraw-tx-hash';
      const streamId = 21;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'withdraw-event-1',
        type: 'contract',
        ledger: 4000,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('tokens_withdrawn'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('recipient', mockAccountAddr()),
            mockMapEntry('amount', mockI128('0', '500')),
            mockMapEntry('timestamp', mockU64('1700002000')),
          ] as any,
        } as any,
      };

      // withdrawnAmount starts at '1000'; a single successful withdrawal of
      // 500 should bring it to '1500' and stay there under replay.
      const mockTx = {
        stream: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ withdrawnAmount: '1000' }),
          update: vi.fn().mockResolvedValue({}),
        },
        streamEvent: {
          findUnique: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ id: 'withdraw-event-row' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // First processing: no existing event → withdrawnAmount is updated once.
      mockTx.streamEvent.findUnique.mockResolvedValueOnce(null);
      await expect((worker as any).handleTokensWithdrawn(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.stream.update).toHaveBeenCalledTimes(1);
      expect(mockTx.stream.update).toHaveBeenCalledWith({
        where: { streamId: BigInt(streamId) },
        data: { withdrawnAmount: '1500', lastUpdateTime: 1700002000 },
      });
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      vi.clearAllMocks();
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Second processing (replay of same txHash): the event now exists, so
      // withdrawnAmount must NOT be touched a second time.
      mockTx.streamEvent.findUnique.mockResolvedValueOnce({ id: 'withdraw-event-row' });
      await expect((worker as any).handleTokensWithdrawn(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.stream.update).not.toHaveBeenCalled();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate StreamEvent skipped'));
    });

    it('should not double-apply depositedAmount/endTime when a stream_topped_up event is re-processed', async () => {
      const txHash = 'topup-tx-hash';
      const streamId = 22;

      const mockEvent: rpc.Api.EventResponse = {
        id: 'topup-event-1',
        type: 'contract',
        ledger: 4001,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('stream_topped_up'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('amount', mockI128('0', '200')),
            mockMapEntry('new_deposited_amount', mockI128('0', '1200')),
          ] as any,
        } as any,
      };

      const mockTx = {
        stream: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ratePerSecond: '10',
            startTime: 1700000000,
            totalPausedDuration: 0,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        streamEvent: {
          findUnique: vi.fn(),
          upsert: vi.fn().mockResolvedValue({ id: 'topup-event-row' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // First processing: no existing event → depositedAmount/endTime are set once.
      mockTx.streamEvent.findUnique.mockResolvedValueOnce(null);
      await expect((worker as any).handleStreamToppedUp(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.stream.update).toHaveBeenCalledTimes(1);
      const firstUpdateArgs = mockTx.stream.update.mock.calls[0]![0];
      expect(firstUpdateArgs.data.depositedAmount).toBe('1200');
      const expectedEndTime = firstUpdateArgs.data.endTime;
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      vi.clearAllMocks();
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Second processing (replay of same txHash): the event now exists, so
      // depositedAmount/endTime must NOT be re-applied.
      mockTx.streamEvent.findUnique.mockResolvedValueOnce({ id: 'topup-event-row' });
      await expect((worker as any).handleStreamToppedUp(mockEvent, mockEvent.topic![1])).resolves.not.toThrow();
      expect(mockTx.stream.update).not.toHaveBeenCalled();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate StreamEvent skipped'));

      // Sanity check: depositedAmount/endTime from the (only) applied update
      // match what a single application should produce.
      expect(firstUpdateArgs.data.depositedAmount).toBe('1200');
      expect(expectedEndTime).toBe(1700000000n + BigInt(Math.floor(1200 / 10)));
    });

    it('should process admin_transferred events successfully', async () => {
      const txHash = 'admin-transferred-tx-hash';

      const mockEvent: rpc.Api.EventResponse = {
        id: 'admin-transferred-event-1',
        type: 'contract',
        ledger: 1006,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('admin_transferred'),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('previous_admin', mockAccountAddr()),
            mockMapEntry('new_admin', mockAccountAddr()),
          ] as any,
        } as any,
      };

      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId: 0n, isActive: false }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: 'event-admin-transferred' }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Handle processEvent which will dispatch to handleAdminTransferred
      await worker.processEvent(mockEvent);

      expect(mockTx.user.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.stream.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            streamId: 0n,
            eventType: 'ADMIN_TRANSFERRED',
            transactionHash: txHash,
            ledgerSequence: 1006,
          }),
        })
      );
    });

    it('persists a u64 streamId above int4 max (2^31-1) without Number coercion (#829)', async () => {
      // int4 max is 2_147_483_647; this value would previously fail with
      // "value out of range for type integer" on insert.
      const streamId = 3_000_000_000n;
      const txHash = 'large-u64-stream-id-tx';

      const mockEvent: rpc.Api.EventResponse = {
        id: 'large-u64-event-1',
        type: 'contract',
        ledger: 5000,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash,
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('stream_created'),
          mockU64(streamId),
        ],
        value: {
          type: 'scvMap',
          ...mockMapValue(streamFields()),
        } as any,
      };

      let capturedStreamUpsert: any = null;
      let capturedEventUpsert: any = null;
      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: {
          upsert: vi.fn().mockImplementation((args) => {
            capturedStreamUpsert = args;
            return Promise.resolve({ streamId, isActive: true });
          }),
        },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockImplementation((args) => {
            capturedEventUpsert = args;
            return Promise.resolve({ id: 'event-large-u64' });
          }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      await expect(
        (worker as any).handleStreamCreated(mockEvent, mockEvent.topic![1]),
      ).resolves.not.toThrow();

      expect(capturedStreamUpsert?.where?.streamId).toBe(streamId);
      expect(capturedStreamUpsert?.create?.streamId).toBe(streamId);
      expect(typeof capturedStreamUpsert?.create?.streamId).toBe('bigint');
      expect(capturedStreamUpsert.create.streamId > 2_147_483_647n).toBe(true);

      expect(capturedEventUpsert?.create?.streamId).toBe(streamId);
      expect(typeof capturedEventUpsert?.create?.streamId).toBe('bigint');
    });

    it('advances cursor past a failed event when later events in the batch succeed', async () => {
      // Setup initial state: lastCursor is 'cursor-initial'
      (prisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'singleton',
        lastLedger: 100,
        lastCursor: 'cursor-initial',
        updatedAt: new Date(),
      });
      (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'singleton',
        lastLedger: 100,
        lastCursor: 'cursor-initial',
        updatedAt: new Date(),
      });

      // Dead-letter upsert: first (and only) failure stays below the retry cap.
      (prisma.indexerDeadLetterEvent.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'dl-1',
        eventId: 'cursor-event-1',
        attempts: 1,
      });

      // Event 1: Missing required body fields for fee_config_updated -> handleFeeConfigUpdated throws
      const event1: rpc.Api.EventResponse = {
        id: 'cursor-event-1',
        type: 'contract',
        ledger: 101,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'tx-failed-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('fee_config_updated'),
        ],
        value: {
          type: 'scvMap',
          map: [] as any,
        } as any,
      };

      // Event 2: Valid admin_transferred event
      const event2: rpc.Api.EventResponse = {
        id: 'cursor-event-2',
        type: 'contract',
        ledger: 102,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'tx-success-2',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('admin_transferred'),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('previous_admin', mockAccountAddr()),
            mockMapEntry('new_admin', mockAccountAddr()),
          ] as any,
        } as any,
      };

      // Event 3: Valid admin_transferred event
      const event3: rpc.Api.EventResponse = {
        id: 'cursor-event-3',
        type: 'contract',
        ledger: 103,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'tx-success-3',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          mockSym('admin_transferred'),
        ],
        value: {
          type: 'scvMap',
          map: [
            mockMapEntry('previous_admin', mockAccountAddr()),
            mockMapEntry('new_admin', mockAccountAddr()),
          ] as any,
        } as any,
      };

      // Mock getEvents on worker.server
      vi.spyOn((worker as any).server, 'getEvents').mockResolvedValue({
        events: [event1, event2, event3],
      });

      // Track upserted stream events
      const upsertedStreamEvents: any[] = [];
      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId: 0n, isActive: false }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockImplementation((args) => {
            upsertedStreamEvents.push(args);
            return Promise.resolve({ id: 'event-id' });
          }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Run fetchAndProcessEvents
      await (worker as any).fetchAndProcessEvents();

      // Assert successful later events (event2 and event3) were written exactly once each
      const event1Writes = upsertedStreamEvents.filter(
        (e) => e.create?.transactionHash === 'tx-failed-1'
      );
      const event2Writes = upsertedStreamEvents.filter(
        (e) => e.create?.transactionHash === 'tx-success-2'
      );
      const event3Writes = upsertedStreamEvents.filter(
        (e) => e.create?.transactionHash === 'tx-success-3'
      );

      expect(event1Writes.length).toBe(0);
      expect(event2Writes.length).toBe(1);
      expect(event3Writes.length).toBe(1);

      // Assert: the failed event was dead-lettered with its raw payload so it
      // can be triaged manually.
      expect(prisma.indexerDeadLetterEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'cursor-event-1' },
          create: expect.objectContaining({
            eventId: 'cursor-event-1',
            ledger: 101,
            transactionHash: 'tx-failed-1',
            attempts: 1,
            errorMessage: expect.any(String),
          }),
        }),
      );

      // Assert: the persisted IndexerState.lastCursor DID advance past the
      // failed event's position, because events 2 and 3 processed
      // successfully. A single bad event must not freeze the indexer.
      const indexerUpsertCalls = (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mock.calls;
      const lastSaveCall = indexerUpsertCalls[indexerUpsertCalls.length - 1]![0];

      expect(lastSaveCall.update.lastCursor).toBe('cursor-event-3');
      expect(lastSaveCall.update.lastLedger).toBe(103);
    });

    it('processes the other four events and advances the cursor when one event in a batch of five is malformed', async () => {
      (prisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'singleton',
        lastLedger: 100,
        lastCursor: 'batch-cursor-0',
        updatedAt: new Date(),
      });
      (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'singleton',
        lastLedger: 100,
        lastCursor: 'batch-cursor-0',
        updatedAt: new Date(),
      });
      (prisma.indexerDeadLetterEvent.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'dl-batch',
        eventId: 'batch-bad-3',
        attempts: 1,
      });

      // One deliberately malformed event (position 3) in a batch of five.
      const events = [
        makeAdminTransferredEvent('batch-ok-1', 101, 'tx-batch-1'),
        makeAdminTransferredEvent('batch-ok-2', 102, 'tx-batch-2'),
        makeMalformedEvent('batch-bad-3', 103, 'tx-batch-3'),
        makeAdminTransferredEvent('batch-ok-4', 104, 'tx-batch-4'),
        makeAdminTransferredEvent('batch-ok-5', 105, 'tx-batch-5'),
      ];

      vi.spyOn((worker as any).server, 'getEvents').mockResolvedValue({ events });

      const upsertedStreamEvents: any[] = [];
      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId: 0n, isActive: false }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockImplementation((args) => {
            upsertedStreamEvents.push(args);
            return Promise.resolve({ id: 'event-id' });
          }),
        },
      };
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      await (worker as any).fetchAndProcessEvents();

      // All four valid events processed exactly once; malformed one never written.
      for (const txHash of ['tx-batch-1', 'tx-batch-2', 'tx-batch-4', 'tx-batch-5']) {
        expect(
          upsertedStreamEvents.filter((e) => e.create?.transactionHash === txHash).length,
        ).toBe(1);
      }
      expect(
        upsertedStreamEvents.filter((e) => e.create?.transactionHash === 'tx-batch-3').length,
      ).toBe(0);

      // Malformed event dead-lettered with its raw payload for manual triage.
      expect(prisma.indexerDeadLetterEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'batch-bad-3' },
          create: expect.objectContaining({
            transactionHash: 'tx-batch-3',
            rawPayload: expect.stringContaining('batch-bad-3'),
            attempts: 1,
          }),
        }),
      );

      // Cursor advances past the malformed event to the last processed event.
      const lastSaveCall =
        (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      expect(lastSaveCall.update.lastCursor).toBe('batch-ok-5');
      expect(lastSaveCall.update.lastLedger).toBe(105);

      // Counters reflect 4 processed, 1 failed.
      const counters = worker.getEventCounters();
      expect(counters.eventsProcessed).toBe(4);
      expect(counters.eventsFailed).toBe(1);
      expect(counters.lastErrorAt).not.toBeNull();
    });

    it('abandons an always-failing event after the retry cap and advances past it', async () => {
      process.env.INDEXER_DEAD_LETTER_MAX_RETRIES = '2';
      worker = new SorobanEventWorker();

      (prisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'singleton',
        lastLedger: 100,
        lastCursor: 'cap-cursor-0',
        updatedAt: new Date(),
      });
      (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'singleton',
        lastLedger: 100,
        lastCursor: 'cap-cursor-0',
        updatedAt: new Date(),
      });

      const okEvent = makeAdminTransferredEvent('cap-ok-1', 101, 'tx-cap-1');
      const badEvent = makeMalformedEvent('cap-bad-2', 102, 'tx-cap-2');

      // Poll 1: both events. Poll 2: only the bad tail event is re-fetched.
      // Poll 3: cursor moved past it — nothing left to fetch.
      const getEvents = vi
        .spyOn((worker as any).server, 'getEvents')
        .mockResolvedValueOnce({ events: [okEvent, badEvent] })
        .mockResolvedValueOnce({ events: [badEvent] })
        .mockResolvedValueOnce({ events: [] });

      // Dead-letter attempts: 1 (below cap) then 2 (cap reached → abandon).
      (prisma.indexerDeadLetterEvent.upsert as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: 'dl-1', eventId: 'cap-bad-2', attempts: 1 })
        .mockResolvedValueOnce({ id: 'dl-2', eventId: 'cap-bad-2', attempts: 2 });

      const mockTx = {
        user: { upsert: vi.fn().mockResolvedValue({}) },
        stream: { upsert: vi.fn().mockResolvedValue({ streamId: 0n, isActive: false }) },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: 'event-id' }),
        },
      };
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb) => cb(mockTx));

      // Poll 1: ok event processed, bad event fails but stays below the cap.
      await (worker as any).fetchAndProcessEvents();
      let lastSaveCall =
        (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      expect(lastSaveCall.update.lastCursor).toBe('cap-ok-1');

      // Poll 2: bad event retried, hits the cap → abandoned, cursor advances past it.
      await (worker as any).fetchAndProcessEvents();
      lastSaveCall =
        (prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      expect(lastSaveCall.update.lastCursor).toBe('cap-bad-2');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded 2 attempts — abandoning'),
      );

      // Poll 3: cursor is past the bad event — no more re-processing.
      await (worker as any).fetchAndProcessEvents();
      expect(getEvents).toHaveBeenCalledTimes(3);
      expect((prisma.indexerState.upsert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

      const counters = worker.getEventCounters();
      expect(counters.eventsProcessed).toBe(1);
      expect(counters.eventsFailed).toBe(2);

      delete process.env.INDEXER_DEAD_LETTER_MAX_RETRIES;
    });
  });

  describe('poll / triggerPoll serialization (#843)', () => {
    it('does not run fetchAndProcessEvents concurrently for overlapping poll and triggerPoll', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const releases: Array<() => void> = [];

      const fetchSpy = vi
        .spyOn(worker as any, 'fetchAndProcessEvents')
        .mockImplementation(async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          concurrent -= 1;
        });

      // Avoid scheduling real timers from poll()'s finally
      vi.spyOn(worker as any, 'scheduleNext').mockImplementation(() => {});
      (worker as any).isRunning = true;

      const pollPromise = (worker as any).poll();
      const triggerPromise = worker.triggerPoll();

      await vi.waitFor(() => expect(releases.length).toBe(1));
      expect(concurrent).toBe(1);

      releases[0]!();
      await vi.waitFor(() => expect(releases.length).toBe(2));
      expect(concurrent).toBe(1);

      releases[1]!();
      await Promise.all([pollPromise, triggerPromise]);

      expect(maxConcurrent).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('waitForDrain awaits an in-flight triggerPoll batch', async () => {
      let resolveFetch!: () => void;
      vi.spyOn(worker as any, 'fetchAndProcessEvents').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      vi.spyOn(worker as any, 'scheduleNext').mockImplementation(() => {});
      (worker as any).isRunning = true;

      const triggerPromise = worker.triggerPoll();
      // activeBatch is registered synchronously in runExclusive
      expect((worker as any).activeBatch).not.toBeNull();

      let drained = false;
      const drainPromise = worker.waitForDrain().then(() => {
        drained = true;
      });

      await Promise.resolve();
      expect(drained).toBe(false);

      resolveFetch();
      await Promise.all([triggerPromise, drainPromise]);
      expect(drained).toBe(true);
      expect((worker as any).activeBatch).toBeNull();
    });
  });
});
