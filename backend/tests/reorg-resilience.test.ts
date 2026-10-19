/**
 * Ledger reorg & fork recovery engine (issue #1468).
 *
 * These tests simulate an RPC node failover that serves a fork: the persisted
 * checkpoint hashes no longer match the ledgers the node reports, so the worker
 * must detect the divergence, roll every mutation above the last still-canonical
 * ledger back inside one transaction, restore stream balances from the surviving
 * event log, and resume forward from the recovered ledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => {
  const tx = {
    streamEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
    stream: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    ledgerCheckpoint: { updateMany: vi.fn() },
    indexerState: { upsert: vi.fn() },
  };
  return {
    tx,
    prisma: {
      ledgerCheckpoint: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        upsert: vi.fn(),
      },
      indexerDeadLetterEvent: { upsert: vi.fn() },
      $transaction: vi.fn((cb: (client: unknown) => unknown) => cb(tx)),
    },
  };
});

vi.mock('../src/lib/prisma.js', () => ({
  prisma: hoisted.prisma,
  default: hoisted.prisma,
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from '../src/lib/prisma.js';
import logger from '../src/logger.js';
import { indexerReorgEventsTotal } from '../src/lib/metrics.js';
import * as checkpoint from '../src/services/checkpoint.service.js';

const mockedPrisma = prisma as unknown as typeof hoisted.prisma;
const tx = hoisted.tx;

const checkpointRow = (ledgerSequence: number, ledgerHash: string) => ({
  ledgerSequence,
  ledgerHash,
  parentHash: `${ledgerHash}-parent`,
  eventsCount: 3,
  stateRootHash: 'root',
  isReverted: false,
});

/** Stream row as stored when the fork's withdrawal was still applied. */
const streamRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'stream-uuid',
  streamId: 42n,
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  tokenAddress: 'CTOKEN',
  ratePerSecond: '10',
  depositedAmount: '1000',
  withdrawnAmount: '1500',
  startTime: 1_700_000_000n,
  lastUpdateTime: 1_700_002_000n,
  endTime: 1_700_000_100n,
  isActive: true,
  isPaused: false,
  pausedAt: null,
  totalPausedDuration: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const streamEventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-uuid',
  streamId: 42n,
  eventType: 'CREATED',
  amount: '1000',
  transactionHash: 'tx',
  ledgerSequence: 1000,
  timestamp: 1_700_000_000n,
  metadata: null,
  createdAt: new Date(),
  ...overrides,
});

describe('computeStateRootHash', () => {
  it('is order-independent so the same batch yields the same root across failovers', () => {
    const first = checkpoint.computeStateRootHash([
      { ledgerSequence: 1, transactionHash: 't1', eventType: 'CREATED' },
      { ledgerSequence: 2, transactionHash: 't2', eventType: 'WITHDRAWN' },
    ]);
    const reversed = checkpoint.computeStateRootHash([
      { ledgerSequence: 2, transactionHash: 't2', eventType: 'WITHDRAWN' },
      { ledgerSequence: 1, transactionHash: 't1', eventType: 'CREATED' },
    ]);

    expect(first).toBe(reversed);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the ingested set changes', () => {
    const a = checkpoint.computeStateRootHash([
      { ledgerSequence: 1, transactionHash: 't1', eventType: 'CREATED' },
    ]);
    const b = checkpoint.computeStateRootHash([
      { ledgerSequence: 1, transactionHash: 't1', eventType: 'CREATED' },
      { ledgerSequence: 1, transactionHash: 't2', eventType: 'WITHDRAWN' },
    ]);

    expect(a).not.toBe(b);
  });
});

describe('recordCheckpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists sequence, hashes, event count and state root keyed by ledger', async () => {
    mockedPrisma.ledgerCheckpoint.upsert.mockResolvedValue({});

    await checkpoint.recordCheckpoint({
      sequence: 1005,
      hash: 'ledger-hash-1005',
      parentHash: 'ledger-hash-1004',
      eventsCount: 7,
      stateRootHash: 'abc123',
    });

    const call = mockedPrisma.ledgerCheckpoint.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ ledgerSequence: 1005 });
    expect(call.create).toMatchObject({
      ledgerSequence: 1005,
      ledgerHash: 'ledger-hash-1005',
      parentHash: 'ledger-hash-1004',
      eventsCount: 7,
      stateRootHash: 'abc123',
      isReverted: false,
    });
  });
});

describe('detectReorg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports no reorg when the newest checkpoint still matches the chain', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1005, 'h5')]);
    const fetchHeader = vi.fn(async (sequence: number) => ({
      sequence,
      hash: 'h5',
      parentHash: 'h4',
    }));

    const detection = await checkpoint.detectReorg(fetchHeader);

    expect(detection.reorg).toBe(false);
    expect(detection.safeLedger).toBe(1005);
    expect(detection.firstInvalidLedger).toBeNull();
    expect(fetchHeader).toHaveBeenCalledTimes(1);
  });

  it('detects a hash mismatch and walks back to the last canonical checkpoint', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1005, 'h5'),
      checkpointRow(1004, 'h4'),
      checkpointRow(1003, 'h3'),
    ]);
    // The node now serves a fork at 1004-1005 but 1003 is still canonical.
    const canonical: Record<number, string> = { 1005: 'fork-5', 1004: 'fork-4', 1003: 'h3' };
    const fetchHeader = vi.fn(async (sequence: number) => ({
      sequence,
      hash: canonical[sequence]!,
      parentHash: 'x',
    }));

    const detection = await checkpoint.detectReorg(fetchHeader);

    expect(detection.reorg).toBe(true);
    expect(detection.verifiedLedger).toBe(1003);
    expect(detection.safeLedger).toBe(1003);
    expect(detection.firstInvalidLedger).toBe(1004);
  });

  it('fails safe (no reorg) when the canonical header cannot be read', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1005, 'h5')]);
    const fetchHeader = vi.fn(async () => null);

    const detection = await checkpoint.detectReorg(fetchHeader);

    // A transient RPC outage must never trigger a destructive rollback.
    expect(detection.reorg).toBe(false);
    expect(detection.unverifiable).toBe(true);
    expect(detection.safeLedger).toBe(0);
  });

  it('treats an RPC throw during verification as unverifiable rather than a reorg', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1005, 'h5')]);
    const fetchHeader = vi.fn(async () => {
      throw new Error('RPC node desynchronized');
    });

    const detection = await checkpoint.detectReorg(fetchHeader);

    expect(detection.reorg).toBe(false);
    expect(detection.unverifiable).toBe(true);
  });
});

describe('rollbackAboveLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes reverted events and restores withdrawnAmount from the survivors', async () => {
    // The fork applied a 500 withdrawal at ledger 1004 that must be undone.
    tx.streamEvent.findMany
      .mockResolvedValueOnce([{ streamId: 42n, ledgerSequence: 1004 }])
      .mockResolvedValueOnce([
        streamEventRow({ ledgerSequence: 1000, eventType: 'CREATED', amount: '1000' }),
        streamEventRow({
          ledgerSequence: 1001,
          eventType: 'WITHDRAWN',
          amount: '1000',
          timestamp: 1_700_001_000n,
        }),
      ]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 1 });
    tx.stream.findUnique.mockResolvedValue(streamRow());
    tx.stream.update.mockResolvedValue({});
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    tx.indexerState.upsert.mockResolvedValue({});

    const result = await checkpoint.rollbackAboveLedger(1002);

    // Every mutation must run inside the single transaction.
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.streamEvent.deleteMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: 1002 } },
    });

    // Balance drift removed: 1500 (with fork withdrawal) -> 1000 (survivors only).
    expect(tx.stream.update).toHaveBeenCalledTimes(1);
    const update = tx.stream.update.mock.calls[0]![0];
    expect(update.where).toEqual({ streamId: 42n });
    expect(update.data.withdrawnAmount).toBe('1000');

    // No orphaned stream, and the reverted checkpoint is flagged.
    expect(tx.stream.delete).not.toHaveBeenCalled();
    expect(tx.ledgerCheckpoint.updateMany).toHaveBeenCalledWith({
      where: { ledgerSequence: { gt: 1002 }, isReverted: false },
      data: { isReverted: true },
    });

    // Cursor rewinds with a null cursor so ingestion re-reads from safeLedger.
    expect(tx.indexerState.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastLedger: 1002, lastCursor: null },
      update: { lastLedger: 1002, lastCursor: null },
    });

    expect(result).toMatchObject({
      safeLedger: 1002,
      eventsDeleted: 1,
      streamsRecomputed: 1,
      streamsDeleted: 0,
      checkpointsReverted: 1,
      ledgersRolledBack: 1,
      highestRevertedLedger: 1004,
    });
  });

  it('deletes a stream that only ever existed on the discarded fork', async () => {
    tx.streamEvent.findMany
      .mockResolvedValueOnce([{ streamId: 99n, ledgerSequence: 1005 }])
      .mockResolvedValueOnce([]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 2 });
    tx.stream.findUnique.mockResolvedValue(streamRow({ streamId: 99n }));
    tx.stream.delete.mockResolvedValue({});
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    tx.indexerState.upsert.mockResolvedValue({});

    const result = await checkpoint.rollbackAboveLedger(1003);

    expect(tx.stream.delete).toHaveBeenCalledWith({ where: { streamId: 99n } });
    expect(tx.stream.update).not.toHaveBeenCalled();
    expect(result.streamsDeleted).toBe(1);
  });

  it('never deletes the system stream (streamId 0) even with no remaining events', async () => {
    tx.streamEvent.findMany
      .mockResolvedValueOnce([{ streamId: 0n, ledgerSequence: 1005 }])
      .mockResolvedValueOnce([]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 1 });
    tx.stream.findUnique.mockResolvedValue(streamRow({ streamId: 0n }));
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 0 });
    tx.indexerState.upsert.mockResolvedValue({});

    const result = await checkpoint.rollbackAboveLedger(1004);

    expect(tx.stream.delete).not.toHaveBeenCalled();
    expect(result.streamsDeleted).toBe(0);
  });
});

describe('verifyAndRecover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Spy on the shared counter so the assertion is about the rollback path,
    // not about whatever value the process-wide registry happens to hold.
    vi.spyOn(indexerReorgEventsTotal, 'inc');
  });

  it('is a no-op when the chain is still canonical', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([]);
    const fetchHeader = vi.fn();

    const result = await checkpoint.verifyAndRecover(fetchHeader);

    expect(result.detected).toBe(false);
    expect(result.rollback).toBeNull();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(indexerReorgEventsTotal.inc).not.toHaveBeenCalled();
  });

  it('rolls back, counts the reorg, and escalates an outsized revert to triage', async () => {
    // Fork replaces everything above ledger 1004.
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1011, 'h11'),
      checkpointRow(1005, 'h5'),
      checkpointRow(1004, 'h4'),
    ]);
    const fetchHeader = vi.fn(async (sequence: number) => ({
      sequence,
      hash: sequence === 1004 ? 'h4' : `fork-${sequence}`,
      parentHash: 'x',
    }));

    // Seven distinct ledgers above safeLedger 1004 -> exceeds the default 5.
    tx.streamEvent.findMany
      .mockResolvedValueOnce(
        [1005, 1006, 1007, 1008, 1009, 1010, 1011].map((ledgerSequence) => ({
          streamId: 7n,
          ledgerSequence,
        })),
      )
      .mockResolvedValueOnce([
        streamEventRow({
          streamId: 7n,
          ledgerSequence: 900,
          eventType: 'CREATED',
          amount: '900',
        }),
      ]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 12 });
    tx.stream.findUnique.mockResolvedValue(streamRow({ streamId: 7n, withdrawnAmount: '400' }));
    tx.stream.update.mockResolvedValue({});
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 7 });
    tx.indexerState.upsert.mockResolvedValue({});
    mockedPrisma.indexerDeadLetterEvent.upsert.mockResolvedValue({});

    const result = await checkpoint.verifyAndRecover(fetchHeader);

    expect(result.detected).toBe(true);
    expect(result.detection.safeLedger).toBe(1004);
    expect(result.rollback?.ledgersRolledBack).toBe(7);
    expect(indexerReorgEventsTotal.inc).toHaveBeenCalledWith({ outcome: 'rolled_back' });

    // Escalation: critical log + dead-letter triage row for operators.
    expect(logger.error).toHaveBeenCalled();
    expect(result.exceededThreshold).toBe(true);
    expect(result.quarantined).toBe(true);
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).toHaveBeenCalledTimes(1);
    const deadLetter = mockedPrisma.indexerDeadLetterEvent.upsert.mock.calls[0]![0];
    expect(deadLetter.create.eventType).toBe('ledger_reorg');
    expect(deadLetter.create.ledgerSequence).toBe(1005);
  });

  it('does not escalate a small rollback below the threshold', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1006, 'h6'),
      checkpointRow(1005, 'h5'),
    ]);
    const fetchHeader = vi.fn(async (sequence: number) => ({
      sequence,
      hash: sequence === 1005 ? 'h5' : 'fork-6',
      parentHash: 'x',
    }));

    tx.streamEvent.findMany
      .mockResolvedValueOnce([{ streamId: 3n, ledgerSequence: 1006 }])
      .mockResolvedValueOnce([]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 1 });
    tx.stream.findUnique.mockResolvedValue(streamRow({ streamId: 3n }));
    tx.stream.delete.mockResolvedValue({});
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    tx.indexerState.upsert.mockResolvedValue({});

    const result = await checkpoint.verifyAndRecover(fetchHeader, { alertThreshold: 5 });

    expect(result.detected).toBe(true);
    expect(result.exceededThreshold).toBe(false);
    expect(result.quarantined).toBe(false);
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).not.toHaveBeenCalled();
  });
});

describe('forward resumption after rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rewinds the cursor to the safe ledger with a null cursor so re-ingest starts there', async () => {
    tx.streamEvent.findMany
      .mockResolvedValueOnce([{ streamId: 5n, ledgerSequence: 1005 }])
      .mockResolvedValueOnce([]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 1 });
    tx.stream.findUnique.mockResolvedValue(streamRow({ streamId: 5n }));
    tx.stream.delete.mockResolvedValue({});
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    tx.indexerState.upsert.mockResolvedValue({});

    await checkpoint.rollbackAboveLedger(1004);

    const upsert = tx.indexerState.upsert.mock.calls[0]![0];
    // A null cursor forces the poll loop to fetch by startLedger = safeLedger,
    // replaying the canonical sequence forward from the recovered ledger.
    expect(upsert.update.lastLedger).toBe(1004);
    expect(upsert.update.lastCursor).toBeNull();
  });
});
