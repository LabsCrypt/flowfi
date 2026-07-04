/**
 * Regression tests for issue #801 — "Two indexers run concurrently".
 *
 * Previously both `sorobanIndexerService` (services/soroban-indexer.service.ts)
 * and `SorobanEventWorker` (workers/soroban-event-worker.ts) polled
 * STREAM_CONTRACT_ID and wrote Stream/StreamEvent rows. Their WITHDRAWN
 * handlers each did a READ-then-ADD on `withdrawnAmount` in separate
 * transactions, so the same event could be applied twice → inflated balance.
 *
 * These tests lock in the fix:
 *   1. Only ONE indexer (the worker) polls the contract — the legacy service
 *      is deleted and is no longer wired into the server entry-point.
 *   2. Observing the same WITHDRAWN event twice increments `withdrawnAmount`
 *      exactly once.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';

// ─── Mocks (must be registered before importing the worker) ──────────────────

vi.mock('../src/lib/prisma.js', () => ({
  default: { indexerState: { upsert: vi.fn() } },
  prisma: {
    indexerState: { upsert: vi.fn() },
    stream: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    streamEvent: { findUnique: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: { broadcastToStream: vi.fn() },
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { prisma } from '../src/lib/prisma.js';
import { sseService } from '../src/services/sse.service.js';
import logger from '../src/logger.js';

const srcUrl = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('#801 single indexer', () => {
  describe('only one indexer instance polls the contract', () => {
    it('deletes the legacy soroban-indexer.service module', () => {
      expect(existsSync(srcUrl('../src/services/soroban-indexer.service.ts'))).toBe(false);
    });

    it('does not wire the legacy indexer service into the server entry-point', () => {
      const indexSrc = readFileSync(srcUrl('../src/index.ts'), 'utf8');
      expect(indexSrc).not.toMatch(/soroban-indexer\.service/);
      expect(indexSrc).not.toMatch(/sorobanIndexerService/);
      // The worker remains the single indexer started at boot.
      expect(indexSrc).toMatch(/startWorkers\(\)/);
    });

    it('exposes exactly one contract poller — the SorobanEventWorker', () => {
      // startWorkers() is the only indexer bootstrap; it starts the worker and
      // nothing else. (See workers/index.ts.)
      const workersSrc = readFileSync(srcUrl('../src/workers/index.ts'), 'utf8');
      expect(workersSrc).toMatch(/sorobanEventWorker\.start\(\)/);
      expect(workersSrc).not.toMatch(/sorobanIndexerService/);
    });
  });

  describe('withdrawnAmount is not double-incremented on a repeated WITHDRAWN event', () => {
    let worker: SorobanEventWorker;

    const streamId = 7;
    const buildEvent = (): rpc.Api.EventResponse =>
      ({
        id: 'withdraw-event-1',
        type: 'contract',
        ledger: 4000,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'withdraw-tx-hash',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [
          { switch: () => ({ value: 0 }), sym: () => 'tokens_withdrawn' } as any,
          { switch: () => ({ value: 1 }), u64: () => ({ toString: () => streamId.toString() }) } as any,
        ],
        value: {
          switch: () => ({ value: 4 }),
          map: () => [
            { key: () => ({ sym: () => 'recipient' }), val: () => ({ address: () => ({ switch: () => ({ value: 0 }), accountId: () => ({ ed25519: () => Buffer.alloc(32) }) }) }) },
            { key: () => ({ sym: () => 'amount' }), val: () => ({ i128: () => ({ hi: () => ({ toString: () => '0' }), lo: () => ({ toString: () => '100' }) }) }) },
            { key: () => ({ sym: () => 'timestamp' }), val: () => ({ u64: () => ({ toString: () => '1700005000' }) }) },
          ] as any,
        } as any,
      }) as rpc.Api.EventResponse;

    beforeEach(() => {
      vi.clearAllMocks();
      worker = new SorobanEventWorker();
    });

    it('applies the increment once and skips it when the event is seen again', async () => {
      // A tiny stateful stand-in for the DB so the second observation genuinely
      // sees the recorded event (as it would in production).
      const db = {
        withdrawnAmount: '0',
        recordedEvent: null as { id: string } | null,
      };

      const mockTx = {
        streamEvent: {
          findUnique: vi.fn(async () => db.recordedEvent),
          upsert: vi.fn(async () => {
            db.recordedEvent = { id: 'withdraw-event-row' };
            return db.recordedEvent;
          }),
        },
        stream: {
          findUniqueOrThrow: vi.fn(async () => ({ withdrawnAmount: db.withdrawnAmount })),
          update: vi.fn(async ({ data }: { data: { withdrawnAmount: string } }) => {
            db.withdrawnAmount = data.withdrawnAmount;
            return {};
          }),
        },
      };

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        (cb: (tx: typeof mockTx) => unknown) => cb(mockTx),
      );

      const event = buildEvent();

      // First observation: increment 0 → 100 and record the event.
      await (worker as any).handleTokensWithdrawn(event, event.topic![1]);
      expect(db.withdrawnAmount).toBe('100');
      expect(mockTx.stream.update).toHaveBeenCalledTimes(1);
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);
      expect(sseService.broadcastToStream).toHaveBeenCalledTimes(1);

      // Second observation of the SAME event: must be a no-op for the balance.
      await (worker as any).handleTokensWithdrawn(event, event.topic![1]);
      expect(db.withdrawnAmount).toBe('100'); // NOT '200'
      expect(mockTx.stream.update).toHaveBeenCalledTimes(1); // still once
      expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1); // still once
      // No duplicate SSE notification for the repeated event.
      expect(sseService.broadcastToStream).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate StreamEvent skipped'),
      );
    });
  });
});
