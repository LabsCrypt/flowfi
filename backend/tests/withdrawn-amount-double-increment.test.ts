import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';

/**
 * Regression tests for issue #801 — withdrawnAmount double-counting.
 *
 * These tests prove that:
 * 1. The WITHDRAWN handler uses an atomic DB-level increment (not read-then-add).
 * 2. Processing the same event twice is a no-op on the second attempt (idempotency).
 * 3. Two near-simultaneous withdrawals on the same stream are both applied correctly
 *    when they carry different txHashes (no lost updates).
 */

const mockPrismaObj = vi.hoisted(() => ({
  indexerState: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
  },
  user: { upsert: vi.fn() },
  stream: {
    upsert: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  streamEvent: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn((cb: Function) =>
    cb({
      stream: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
      streamEvent: { findUnique: vi.fn(), upsert: vi.fn() },
      $executeRaw: vi.fn().mockResolvedValue(1),
    }),
  ),
  $disconnect: vi.fn(),
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

function makeWithdrawnEvent(
  txHash: string,
  streamId: number,
  amount: string,
  ledger: number,
): rpc.Api.EventResponse {
  return {
    id: `event-${txHash}`,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [
      {
        switch: () => ({ value: 0 }),
        sym: () => 'tokens_withdrawn',
      } as any,
      {
        switch: () => ({ value: 1 }),
        u64: () => ({ toString: () => streamId.toString() }),
      } as any,
    ],
    value: {
      switch: () => ({ value: 4 }),
      map: () => [
        {
          key: () => ({ sym: () => 'recipient' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 0 }),
              accountId: () => ({ ed25519: () => Buffer.alloc(32) }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'amount' }),
          val: () => ({
            i128: () => ({
              hi: () => ({ toString: () => '0' }),
              lo: () => ({ toString: () => amount }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'timestamp' }),
          val: () => ({
            u64: () => ({ toString: () => '1700002000' }),
          }),
        },
      ] as any,
    } as any,
  };
}

describe('withdrawnAmount double-increment prevention (#801)', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventWorker();
  });

  it('uses atomic $executeRaw instead of read-then-add', async () => {
    const streamId = 42;
    const event = makeWithdrawnEvent('tx-atomic', streamId, '500', 4000);

    const mockExecuteRaw = vi.fn().mockResolvedValue(1);
    const mockTx = {
      stream: {
        findUniqueOrThrow: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      streamEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'evt-1' }),
      },
      $executeRaw: mockExecuteRaw,
    };

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: Function) =>
      cb(mockTx),
    );

    await (worker as any).handleTokensWithdrawn(event, event.topic![1]);

    // The update must use an atomic $executeRaw, NOT a pre-read + string concat
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // stream.update must NOT have been called for withdrawnAmount (only $executeRaw)
    expect(mockTx.stream.update).not.toHaveBeenCalled();
    // stream.findUniqueOrThrow must NOT have been called (no read-then-add)
    expect(mockTx.stream.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('processing the same event twice is a no-op on the second attempt', async () => {
    const streamId = 55;
    const event = makeWithdrawnEvent('tx-idempotent', streamId, '300', 4100);

    // First processing: event does not exist → should execute atomic increment
    const mockExecuteRaw1 = vi.fn().mockResolvedValue(1);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: Function) =>
      cb({
        stream: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: 'evt-idem' }),
        },
        $executeRaw: mockExecuteRaw1,
      }),
    );

    await (worker as any).handleTokensWithdrawn(event, event.topic![1]);
    expect(mockExecuteRaw1).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second processing: event already exists (duplicate) → should NOT execute atomic increment
    const mockExecuteRaw2 = vi.fn().mockResolvedValue(1);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: Function) =>
      cb({
        stream: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
        streamEvent: {
          findUnique: vi.fn().mockResolvedValue({ id: 'evt-idem' }),
          upsert: vi.fn(),
        },
        $executeRaw: mockExecuteRaw2,
      }),
    );

    await (worker as any).handleTokensWithdrawn(event, event.topic![1]);

    // The second call must NOT execute the atomic increment or upsert
    expect(mockExecuteRaw2).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate StreamEvent skipped'),
    );
  });

  it('two different withdrawals on the same stream both trigger atomic increments', async () => {
    const streamId = 77;
    const event1 = makeWithdrawnEvent('tx-first', streamId, '100', 5000);
    const event2 = makeWithdrawnEvent('tx-second', streamId, '200', 5001);

    const mockExecuteRaw1 = vi.fn().mockResolvedValue(1);
    const mockTx1 = {
      stream: {
        findUniqueOrThrow: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      streamEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'evt-1' }),
      },
      $executeRaw: mockExecuteRaw1,
    };

    const mockExecuteRaw2 = vi.fn().mockResolvedValue(1);
    const mockTx2 = {
      stream: {
        findUniqueOrThrow: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      streamEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'evt-2' }),
      },
      $executeRaw: mockExecuteRaw2,
    };

    let callCount = 0;
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation((cb: Function) => {
      const tx = callCount++ === 0 ? mockTx1 : mockTx2;
      return cb(tx);
    });

    await (worker as any).handleTokensWithdrawn(event1, event1.topic![1]);
    await (worker as any).handleTokensWithdrawn(event2, event2.topic![1]);

    // Both transactions must have executed the atomic increment
    expect(mockExecuteRaw1).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw2).toHaveBeenCalledTimes(1);
  });
});
