/**
 * Operator reorg surface on `indexerService` (issue #1759).
 *
 * `getReorgStatus()` and `recoverFromReorg()` are the two exported functions an
 * operator uses to see and clear a fork, and nothing referenced them: not a
 * route, not a test. A regression in either — the reverted-ledger filter
 * dropping, the recovery running outside the batch mutex, or a poll firing when
 * nothing was detected — was invisible.
 *
 * The checkpoint reads are real and run through the mocked Prisma client, so
 * the query shapes that decide what an operator sees are asserted rather than
 * stubbed away. Only the worker singleton is mocked: `recoverFromReorg` exists
 * to run under its mutex, and constructing a second indexer in a test process
 * would start a poll timer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  prisma: {
    ledgerCheckpoint: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    indexerDeadLetterEvent: { upsert: vi.fn() },
    indexerState: { findUnique: vi.fn(), upsert: vi.fn() },
    streamEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
    stream: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
  worker: {
    runExclusive: vi.fn((fn: () => Promise<unknown>) => fn()),
    triggerPoll: vi.fn(async () => 'request-id'),
    fetchLedgerHeader: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: hoisted.prisma,
  default: hoisted.prisma,
}));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: hoisted.worker,
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  requestContext: {
    getStore: vi.fn(() => undefined),
    run: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

// Stubbed so the assertions are not perturbed by the shared Prometheus
// registry, matching the other indexer-service suites.
vi.mock('../src/lib/metrics.js', () => ({
  setIndexerLedgers: vi.fn(),
  setIndexerRevertedLedgers: vi.fn(),
  indexerReorgEventsTotal: { inc: vi.fn() },
  indexerEventsProcessedTotal: { inc: vi.fn() },
  indexerPollsTotal: { inc: vi.fn() },
  recordRpcRequest: vi.fn(),
}));

import { prisma } from '../src/lib/prisma.js';
import * as indexerService from '../src/services/indexerService.js';

const mockedPrisma = prisma as unknown as typeof hoisted.prisma;
const worker = hoisted.worker;

const checkpointRow = (overrides: Record<string, unknown> = {}) => ({
  ledgerSequence: 1006,
  ledgerHash: 'hash-1006',
  parentHash: 'hash-1005',
  eventsCount: 3,
  stateRootHash: 'root-1006',
  isReverted: false,
  processedAt: new Date('2026-11-21T00:00:00.000Z'),
  ...overrides,
});

describe('getReorgStatus (issue #1759)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the newest checkpoint including reverted ones', async () => {
    // `includeReverted` is the whole point: right after a rollback the newest
    // checkpoint IS reverted, and a status view that filtered it out would
    // report the ledger below the fork as the indexer's position.
    mockedPrisma.ledgerCheckpoint.findFirst.mockResolvedValue(checkpointRow({ isReverted: true }));
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([]);

    const status = await indexerService.getReorgStatus();

    expect(mockedPrisma.ledgerCheckpoint.findFirst).toHaveBeenCalledWith({
      where: {},
      orderBy: { ledgerSequence: 'desc' },
    });
    expect(status.lastCheckpoint).toEqual({
      ledgerSequence: 1006,
      ledgerHash: 'hash-1006',
      parentHash: 'hash-1005',
      eventsCount: 3,
      stateRootHash: 'root-1006',
      isReverted: true,
      processedAt: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(status.recentRevertedLedgers).toEqual([]);
  });

  it('lists the reverted ledgers of the recent window and nothing else', async () => {
    mockedPrisma.ledgerCheckpoint.findFirst.mockResolvedValue(checkpointRow());
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow({ ledgerSequence: 1010, isReverted: true }),
      checkpointRow({ ledgerSequence: 1009, isReverted: false }),
      checkpointRow({ ledgerSequence: 1008, isReverted: true }),
    ]);

    const status = await indexerService.getReorgStatus();

    expect(status.recentRevertedLedgers).toEqual([1010, 1008]);
    // The window the operator sees is 50 ledgers, clamped by the service's own
    // 1..100 guard, and newest first so the list reads like a timeline.
    expect(mockedPrisma.ledgerCheckpoint.findMany).toHaveBeenCalledWith({
      orderBy: { ledgerSequence: 'desc' },
      take: 50,
    });
  });

  it('reports no checkpoint at all on a database that has never indexed', async () => {
    mockedPrisma.ledgerCheckpoint.findFirst.mockResolvedValue(null);
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([]);

    const status = await indexerService.getReorgStatus();

    expect(status.lastCheckpoint).toBeNull();
    expect(status.recentRevertedLedgers).toEqual([]);
  });

  it('reads both queries concurrently so the view cannot straddle a rollback', async () => {
    // `Promise.all` is what keeps the reported checkpoint and the reverted list
    // from coming from two different states of the table.
    let releaseFirst: (value: null) => void = () => {};
    const firstPending = new Promise<null>((resolve) => {
      releaseFirst = resolve;
    });
    mockedPrisma.ledgerCheckpoint.findFirst.mockReturnValue(firstPending);
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([]);

    const pending = indexerService.getReorgStatus();
    await Promise.resolve();

    expect(mockedPrisma.ledgerCheckpoint.findMany).toHaveBeenCalledTimes(1);
    releaseFirst(null);
    await expect(pending).resolves.toMatchObject({ lastCheckpoint: null });
  });
});

describe('recoverFromReorg (issue #1759)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) =>
      cb(recordingTransaction()),
    );
    mockedPrisma.indexerDeadLetterEvent.upsert.mockResolvedValue({});
  });

  /** A transaction client that records rather than touches a database. */
  function recordingTransaction() {
    return {
      streamEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      stream: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        delete: vi.fn(),
      },
      ledgerCheckpoint: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      indexerState: { upsert: vi.fn().mockResolvedValue({}) },
    };
  }

  /** No checkpoints stored means `detectReorg` short-circuits before any fetch. */
  function noCheckpoints() {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([]);
  }

  it('runs the verification inside the worker mutex', async () => {
    noCheckpoints();

    await indexerService.recoverFromReorg();

    expect(worker.runExclusive).toHaveBeenCalledTimes(1);
    expect(worker.runExclusive.mock.calls[0]![0]).toBeTypeOf('function');
    // The mutex is what prevents an operator recovery from racing an in-flight
    // batch into two cursor writes; a direct call would not touch it at all.
    expect(worker.fetchLedgerHeader).not.toHaveBeenCalled();
  });

  it('does not trigger a poll when nothing was detected', async () => {
    noCheckpoints();

    const result = await indexerService.recoverFromReorg();

    expect(result.detected).toBe(false);
    expect(result.rollback).toBeNull();
    expect(worker.triggerPoll).not.toHaveBeenCalled();
  });

  it('re-ingests immediately after a real recovery', async () => {
    // Fork above 1000: the stored checkpoints at 1001/1002 keep the hashes of
    // the branch that was replaced, and the network now serves different ones.
    mockedPrisma.ledgerCheckpoint.findMany
      // First call is detectReorg's walk.
      .mockResolvedValueOnce([
        checkpointRow({ ledgerSequence: 1002, ledgerHash: 'fork-1002' }),
        checkpointRow({ ledgerSequence: 1001, ledgerHash: 'fork-1001' }),
        checkpointRow({ ledgerSequence: 1000, ledgerHash: 'hash-1000' }),
      ])
      // listRecentCheckpoints, which detectReorg's caller does not use, stays empty.
      .mockResolvedValue([]);
    worker.fetchLedgerHeader.mockImplementation(async (sequence: number) => ({
      sequence,
      hash: sequence === 1000 ? 'hash-1000' : `canonical-${sequence}`,
      parentHash: 'p',
    }));
    const tx = recordingTransaction();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    const result = await indexerService.recoverFromReorg();

    expect(result.detected).toBe(true);
    expect(result.detection.safeLedger).toBe(1000);
    expect(result.detection.firstInvalidLedger).toBe(1001);
    // The default ceiling is 5, so a two-ledger revert is not escalated here —
    // the operator path deliberately inherits the configured threshold.
    expect(result.exceededThreshold).toBe(false);
    // Walk order is newest-first and stops at the first canonical header.
    expect(worker.fetchLedgerHeader.mock.calls.map(([sequence]) => sequence)).toEqual([
      1002, 1001, 1000,
    ]);
    expect(tx.indexerState.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastLedger: 1000, lastCursor: null },
      update: { lastLedger: 1000, lastCursor: null },
    });
    // The rewind only helps if ingestion actually resumes: without this the
    // operator has to wait a full poll interval to see the canonical fork.
    expect(worker.triggerPoll).toHaveBeenCalledTimes(1);
  });

  it('leaves ingestion alone when the walk finds no fork', async () => {
    mockedPrisma.ledgerCheckpoint.findMany
      .mockResolvedValueOnce([checkpointRow({ ledgerSequence: 1002, ledgerHash: 'hash-1002' })])
      .mockResolvedValue([]);
    worker.fetchLedgerHeader.mockResolvedValue({
      sequence: 1002,
      hash: 'hash-1002',
      parentHash: 'p',
    });

    const result = await indexerService.recoverFromReorg();

    expect(result.detected).toBe(false);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(worker.triggerPoll).not.toHaveBeenCalled();
  });

  it('propagates a verification failure instead of reporting a clean recovery', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockRejectedValue(new Error('table missing'));

    await expect(indexerService.recoverFromReorg()).rejects.toThrow('table missing');
    expect(worker.triggerPoll).not.toHaveBeenCalled();
  });
});
