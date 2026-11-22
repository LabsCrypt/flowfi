/**
 * Indexer cursor, rollback and recovery coverage (issue #1759).
 *
 * `tests/reorg-resilience.test.ts` already proves the recovery engine itself:
 * detection, the walk-back, the atomic rollback, and that an outsized revert
 * escalates. What nothing exercised is the surface around it —
 *
 *  - `detectReorg`'s worst case, where every checkpoint walked is on the fork,
 *    and the exact query that decides how far the walk-back reaches;
 *  - `verifyAndRecover`'s escalation edges: the strict threshold boundary, the
 *    `quarantine: false` opt-out, and what happens when the triage write itself
 *    fails (the one path that can leave a reorg silently unreported);
 *  - the dead-letter row's payload, of which only two fields were checked;
 *  - the worker's pre-ingestion hook in `runPollCycle`, which is where "a
 *    failure to verify is not a reorg" and "re-read the cursor after recovery"
 *    actually live. `checkpointsEnabled` is `contractId.length > 0`, and no
 *    other suite sets `STREAM_CONTRACT_ID` except the checkpoint-recording
 *    test, so this hook ran nowhere before this file;
 *  - `indexerService.getReorgStatus()` / `recoverFromReorg()`, the operator
 *    entry points, which no test or route reached at all.
 *
 * No network and no database: Prisma, the RPC server and the ledger-header
 * fetch are all stubbed, and the rollback is driven through the same
 * `$transaction`-callback mock the existing reorg suite uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      indexerState: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
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
import * as checkpoint from '../src/services/checkpoint.service.js';
import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';

const tx = hoisted.tx;
const mockedPrisma = prisma as unknown as typeof hoisted.prisma;

const CONTRACT_ID =
  'CCONTRACTCONTRACTCONTRACTCONTRACTCONTRACTCONTRACTCONTRACTCONT';

const checkpointRow = (ledgerSequence: number, ledgerHash: string) => ({
  ledgerSequence,
  ledgerHash,
  parentHash: `${ledgerHash}-parent`,
  eventsCount: 3,
  stateRootHash: 'root',
  isReverted: false,
});

const streamRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'stream-uuid',
  streamId: 7n,
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  tokenAddress: 'CTOKEN',
  ratePerSecond: '10',
  depositedAmount: '1000',
  withdrawnAmount: '400',
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

const survivorRow = () => ({
  id: 'event-uuid',
  streamId: 7n,
  eventType: 'CREATED',
  amount: '900',
  transactionHash: 'tx-survivor',
  ledgerSequence: 900,
  timestamp: 1_700_000_000n,
  metadata: null,
  createdAt: new Date(),
});

/** The event-side rows a rollback of `ledgers` sequences above `safeLedger` needs. */
function stubRollback(ledgers: number[], safeLedger: number) {
  tx.streamEvent.findMany
    .mockResolvedValueOnce(
      ledgers.map((ledgerSequence) => ({ streamId: 7n, ledgerSequence })),
    )
    .mockResolvedValueOnce([survivorRow()]);
  tx.streamEvent.deleteMany.mockResolvedValue({ count: ledgers.length });
  tx.stream.findUnique.mockResolvedValue(streamRow());
  tx.stream.update.mockResolvedValue({});
  tx.stream.delete.mockResolvedValue({});
  tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: ledgers.length });
  tx.indexerState.upsert.mockResolvedValue({});
  return safeLedger;
}

/** Fetcher that reports every ledger as forked except those in `canonical`. */
function forkedHeaders(canonical: Record<number, string>): checkpoint.LedgerHeaderFetcher {
  return vi.fn(async (sequence: number) => ({
    sequence,
    hash: canonical[sequence] ?? `fork-${sequence}`,
    parentHash: 'parent',
  }));
}

describe('detectReorg walk-back (issue #1759)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads only live checkpoints, newest first, capped at the walk-back window', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1000, 'h1000')]);

    await checkpoint.detectReorg(forkedHeaders({ 1000: 'h1000' }));

    expect(mockedPrisma.ledgerCheckpoint.findMany).toHaveBeenCalledWith({
      where: { isReverted: false },
      orderBy: { ledgerSequence: 'desc' },
      take: checkpoint.DEFAULT_REORG_WALK_BACK,
    });

    vi.clearAllMocks();
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1000, 'h1000')]);
    await checkpoint.detectReorg(forkedHeaders({ 1000: 'h1000' }), { maxWalkBack: 4 });

    // A bounded walk is what keeps a deep fork from turning one poll cycle into
    // hundreds of RPC calls, so the cap has to reach the query.
    expect(mockedPrisma.ledgerCheckpoint.findMany).toHaveBeenCalledWith({
      where: { isReverted: false },
      orderBy: { ledgerSequence: 'desc' },
      take: 4,
    });
  });

  it('reports the whole walked set as invalid when nothing on it is canonical', async () => {
    // The total-fork case: the RPC node served a chain with no common ancestor
    // inside the window, so there is no verified ledger to resume from.
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1012, 'h12'),
      checkpointRow(1011, 'h11'),
      checkpointRow(1010, 'h10'),
    ]);

    const detection = await checkpoint.detectReorg(forkedHeaders({}));

    expect(detection).toEqual({
      reorg: true,
      verifiedLedger: null,
      // Everything from the lowest walked checkpoint up is suspect, so the safe
      // point is the ledger *below* it — and that is where re-ingestion starts.
      safeLedger: 1009,
      firstInvalidLedger: 1010,
      checked: 3,
      unverifiable: false,
    });
  });

  it('never underflows the safe ledger when the fork reaches genesis', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1, 'h1')]);

    const detection = await checkpoint.detectReorg(forkedHeaders({}));

    expect(detection.safeLedger).toBe(0);
    expect(detection.firstInvalidLedger).toBe(1);
  });

  it('stops walking at the first canonical checkpoint and does not count the rest', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1012, 'h12'),
      checkpointRow(1011, 'h11'),
      checkpointRow(1010, 'h10'),
    ]);
    const fetchHeader = forkedHeaders({ 1011: 'h11' });

    const detection = await checkpoint.detectReorg(fetchHeader);

    expect(detection.verifiedLedger).toBe(1011);
    expect(detection.checked).toBe(2);
    expect(fetchHeader).toHaveBeenCalledTimes(2);
    expect(fetchHeader).toHaveBeenCalledWith(1012);
    expect(fetchHeader).toHaveBeenCalledWith(1011);
  });

  it('abandons the walk and marks itself unverifiable at the first missing header', async () => {
    // A pruned or desynced node answers null. Two checkpoints may already have
    // been walked and mismatched, and the result still says "no reorg" — the
    // fail-safe is deliberate, so it has to be pinned loudly.
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1012, 'h12'),
      checkpointRow(1011, 'h11'),
      checkpointRow(1010, 'h10'),
    ]);
    const fetchHeader = vi
      .fn<checkpoint.LedgerHeaderFetcher>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ sequence: 1, hash: 'x', parentHash: 'p' });

    const detection = await checkpoint.detectReorg(fetchHeader);

    expect(detection.unverifiable).toBe(true);
    expect(detection.reorg).toBe(false);
    expect(detection.checked).toBe(1);
    expect(detection.safeLedger).toBe(0);
  });

  it('treats a throwing fetcher the same as a missing header', async () => {
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([checkpointRow(1012, 'h12')]);
    const fetchHeader = vi.fn().mockRejectedValue(new Error('rpc down'));

    const detection = await checkpoint.detectReorg(fetchHeader);

    expect(detection.unverifiable).toBe(true);
    expect(detection.reorg).toBe(false);
  });
});

describe('verifyAndRecover escalation edges (issue #1759)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));
    mockedPrisma.indexerDeadLetterEvent.upsert.mockResolvedValue({});
  });

  /** A reorg whose rollback covers exactly `count` ledgers above 1000. */
  async function recoverWithRollback(count: number, options?: checkpoint.ReorgRecoveryOptions) {
    const above = Array.from({ length: count }, (_, index) => 1001 + index);
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(above[above.length - 1]!, 'forked'),
      ...above.slice(0, -1).map((ledger) => checkpointRow(ledger, 'forked')),
      checkpointRow(1000, 'h1000'),
    ]);
    stubRollback(above, 1000);
    return checkpoint.verifyAndRecover(forkedHeaders({ 1000: 'h1000' }), options);
  }

  it('escalates strictly above the threshold, not at it', async () => {
    const at = await recoverWithRollback(3, { alertThreshold: 3 });
    expect(at.rollback?.ledgersRolledBack).toBe(3);
    expect(at.exceededThreshold).toBe(false);
    expect(at.quarantined).toBe(false);
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    const over = await recoverWithRollback(4, { alertThreshold: 3 });
    expect(over.rollback?.ledgersRolledBack).toBe(4);
    expect(over.exceededThreshold).toBe(true);
    expect(over.quarantined).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rollback reverted 4 ledgers (threshold 3)'),
    );
  });

  it('falls back to the documented default ceiling when no threshold is given', async () => {
    const under = await recoverWithRollback(checkpoint.DEFAULT_REORG_ALERT_THRESHOLD);
    expect(under.exceededThreshold).toBe(false);

    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    const over = await recoverWithRollback(checkpoint.DEFAULT_REORG_ALERT_THRESHOLD + 1);
    expect(over.exceededThreshold).toBe(true);
    expect(over.detection.safeLedger).toBe(1000);
  });

  it('still rolls back without quarantining when the triage write is suppressed', async () => {
    const result = await recoverWithRollback(6, { quarantine: false });

    expect(result.detected).toBe(true);
    expect(result.exceededThreshold).toBe(true);
    expect(result.quarantined).toBe(false);
    expect(result.rollback?.eventsDeleted).toBe(6);
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).not.toHaveBeenCalled();
    // The rollback is what protects the cursor; suppressing the report must not
    // suppress it.
    expect(tx.streamEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.indexerState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ lastLedger: 1000 }) }),
    );
  });

  it('reports quarantine failure but keeps the rollback when the dead-letter write throws', async () => {
    mockedPrisma.indexerDeadLetterEvent.upsert.mockRejectedValue(new Error('db down'));

    const result = await recoverWithRollback(6);

    expect(result.detected).toBe(true);
    expect(result.exceededThreshold).toBe(true);
    expect(result.quarantined).toBe(false);
    expect(result.rollback?.safeLedger).toBe(1000);
    expect(logger.error).toHaveBeenCalledWith(
      '[CheckpointService] Failed to record reorg dead-letter entry:',
      expect.any(Error),
    );
  });

  it('writes a dead-letter row an operator can act on without opening the payload', async () => {
    await recoverWithRollback(6);

    expect(mockedPrisma.indexerDeadLetterEvent.upsert).toHaveBeenCalledTimes(1);
    const arg = mockedPrisma.indexerDeadLetterEvent.upsert.mock.calls[0]![0] as {
      where: { eventId_eventType: { eventId: string; eventType: string } };
      create: Record<string, unknown> & { eventId: string; payload: string };
      update: Record<string, unknown>;
    };
    // The row is keyed by its own generated id, so a replay of the same
    // detection within the same millisecond is an update, not a second ticket.
    expect(arg.where.eventId_eventType).toEqual({
      eventId: arg.create.eventId,
      eventType: checkpoint.REORG_DEAD_LETTER_EVENT_TYPE,
    });
    expect(arg.create.eventId).toMatch(/^reorg:1001:\d+$/);
    expect(arg.create.eventId).toBe(arg.create.txHash);
    expect(arg.create.ledgerSequence).toBe(1001);
    expect(arg.create.cursor).toBeNull();
    expect(arg.create.attempts).toBe(1);
    expect(arg.create.errorMessage).toBe(
      'Ledger reorg rolled back 6 ledger(s) (above safe ledger 1000)',
    );
    const payload = JSON.parse(arg.create.payload) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['detection', 'recordedAt', 'rollback']);
    expect((payload.detection as { safeLedger: number }).safeLedger).toBe(1000);
    expect((payload.rollback as { ledgersRolledBack: number }).ledgersRolledBack).toBe(6);
    expect(typeof payload.recordedAt).toBe('string');
    expect(arg.update).toEqual({
      errorMessage: arg.create.errorMessage,
      attempts: { increment: 1 },
      lastAttemptAt: expect.any(Date),
    });
  });

  it('uses the safe ledger plus one as the first invalid ledger when detection has none', async () => {
    // `firstInvalidLedger` is null on an unverifiable detection, so the writer
    // derives it; the dead-letter row must still name a ledger.
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1005, 'forked'),
      checkpointRow(1004, 'forked'),
      checkpointRow(1003, 'forked'),
      checkpointRow(1002, 'forked'),
      checkpointRow(1001, 'forked'),
      checkpointRow(1000, 'h1000'),
    ]);
    stubRollback([1001, 1002, 1003, 1004, 1005], 1000);

    await checkpoint.verifyAndRecover(
      vi.fn(async (sequence: number) => ({
        sequence,
        hash: sequence === 1000 ? 'h1000' : `fork-${sequence}`,
        parentHash: 'p',
      })),
      { alertThreshold: 4 },
    );

    const arg = mockedPrisma.indexerDeadLetterEvent.upsert.mock.calls[0]![0] as {
      create: { ledgerSequence: number; eventId: string };
    };
    expect(arg.create.ledgerSequence).toBe(1001);
    expect(arg.create.eventId.startsWith('reorg:1001:')).toBe(true);
  });
});

describe('worker pre-ingestion verification (issue #1759)', () => {
  const previousContractId = process.env.STREAM_CONTRACT_ID;
  const previousThreshold = process.env.INDEXER_REORG_ALERT_THRESHOLD;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));
    tx.streamEvent.findMany.mockResolvedValue([]);
    tx.streamEvent.deleteMany.mockResolvedValue({ count: 0 });
    tx.stream.findUnique.mockResolvedValue(streamRow());
    tx.stream.update.mockResolvedValue({});
    tx.stream.delete.mockResolvedValue({});
    tx.ledgerCheckpoint.updateMany.mockResolvedValue({ count: 0 });
    tx.indexerState.upsert.mockResolvedValue({});
    mockedPrisma.indexerDeadLetterEvent.upsert.mockResolvedValue({});
  });

  afterEach(() => {
    if (previousContractId === undefined) delete process.env.STREAM_CONTRACT_ID;
    else process.env.STREAM_CONTRACT_ID = previousContractId;
    if (previousThreshold === undefined) delete process.env.INDEXER_REORG_ALERT_THRESHOLD;
    else process.env.INDEXER_REORG_ALERT_THRESHOLD = previousThreshold;
  });

  function workerWithContract(): SorobanEventWorker {
    process.env.STREAM_CONTRACT_ID = CONTRACT_ID;
    return new SorobanEventWorker();
  }

  it('keeps indexing when verification itself fails, and says so', async () => {
    const worker = workerWithContract();
    (mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'singleton',
      lastLedger: 1000,
      lastCursor: 'cursor-1000',
    });
    (mockedPrisma.ledgerCheckpoint.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('checkpoint table unreadable'),
    );
    const getEvents = vi.spyOn((worker as any).server, 'getEvents');
    getEvents.mockResolvedValue({ events: [], latestLedger: 1000 } as never);

    await (worker as any).runPollCycle();

    // "A failure to verify is not a reorg": the error is logged, the cursor is
    // untouched by any rollback, and the fetch still happens with the stored
    // cursor rather than a rewind.
    expect(logger.error).toHaveBeenCalledWith(
      '[SorobanWorker] Ledger checkpoint verification failed:',
      expect.any(Error),
    );
    expect(tx.streamEvent.deleteMany).not.toHaveBeenCalled();
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'cursor-1000' }),
    );
    expect((mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('re-reads the cursor after a recovery and fetches from the rewound ledger', async () => {
    const worker = workerWithContract();
    const findUnique = mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>;
    findUnique
      .mockResolvedValueOnce({ id: 'singleton', lastLedger: 1006, lastCursor: 'cursor-1006' })
      // What the rollback wrote: the rewind is only visible to the poll cycle
      // if the state is actually read again.
      .mockResolvedValueOnce({ id: 'singleton', lastLedger: 1000, lastCursor: null });
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1006, 'forked'),
      checkpointRow(1005, 'forked'),
      checkpointRow(1004, 'forked'),
      checkpointRow(1003, 'forked'),
      checkpointRow(1002, 'forked'),
      checkpointRow(1001, 'forked'),
      checkpointRow(1000, 'h1000'),
    ]);
    stubRollback([1001, 1002, 1003, 1004, 1005, 1006], 1000);
    vi.spyOn(worker, 'fetchLedgerHeader').mockImplementation(async (sequence: number) => ({
      sequence,
      hash: sequence === 1000 ? 'h1000' : `fork-${sequence}`,
      parentHash: 'p',
    }));
    const getEvents = vi.spyOn((worker as any).server, 'getEvents');
    getEvents.mockResolvedValue({ events: [], latestLedger: 1010 } as never);

    await (worker as any).runPollCycle();

    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(tx.streamEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[SorobanWorker] Reorg recovered: rolled back above ledger 1000; re-ingesting from there.',
    );
    // No cursor: the rewind nulls it so the batch re-reads by ledger, and the
    // start is the safe ledger rather than the forked one.
    const params = getEvents.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.startLedger).toBe(1000);
    expect(params).not.toHaveProperty('cursor');
  });

  it('does not re-read the cursor when the chain is still canonical', async () => {
    const worker = workerWithContract();
    const findUnique = mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>;
    findUnique.mockResolvedValue({ id: 'singleton', lastLedger: 1006, lastCursor: 'cursor-1006' });
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1006, 'h1006'),
    ]);
    vi.spyOn(worker, 'fetchLedgerHeader').mockResolvedValue({
      sequence: 1006,
      hash: 'h1006',
      parentHash: 'p',
    });
    vi.spyOn((worker as any).server, 'getEvents').mockResolvedValue({
      events: [],
      latestLedger: 1006,
    } as never);

    await (worker as any).runPollCycle();

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(tx.streamEvent.deleteMany).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Reorg recovered'),
    );
  });

  it('passes INDEXER_REORG_ALERT_THRESHOLD through to the escalation decision', async () => {
    process.env.INDEXER_REORG_ALERT_THRESHOLD = '2';
    const worker = workerWithContract();
    (mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'singleton',
      lastLedger: 1006,
      lastCursor: null,
    });
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1004, 'forked'),
      checkpointRow(1003, 'forked'),
      checkpointRow(1002, 'forked'),
      checkpointRow(1001, 'forked'),
      checkpointRow(1000, 'h1000'),
    ]);
    stubRollback([1001, 1002, 1003, 1004], 1000);
    vi.spyOn(worker, 'fetchLedgerHeader').mockImplementation(async (sequence: number) => ({
      sequence,
      hash: sequence === 1000 ? 'h1000' : `fork-${sequence}`,
      parentHash: 'p',
    }));
    vi.spyOn((worker as any).server, 'getEvents').mockResolvedValue({
      events: [],
      latestLedger: 1010,
    } as never);

    await (worker as any).runPollCycle();

    // Four ledgers reverted: above the configured 2, below the default 5. Only
    // the environment value can produce this escalation.
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it('never escalates when the threshold is unparsable, which is the shipped behaviour', async () => {
    // `parseInt('abc', 10)` is NaN and `n > NaN` is false, so a typo in
    // INDEXER_REORG_ALERT_THRESHOLD silently disables triage while the rollback
    // still runs. Pinned as a finding: the day the constructor validates the
    // value, this test is the one that has to change.
    process.env.INDEXER_REORG_ALERT_THRESHOLD = 'abc';
    const worker = workerWithContract();
    (mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'singleton',
      lastLedger: 1006,
      lastCursor: null,
    });
    mockedPrisma.ledgerCheckpoint.findMany.mockResolvedValue([
      checkpointRow(1010, 'forked'),
      checkpointRow(1005, 'forked'),
      checkpointRow(1004, 'forked'),
      checkpointRow(1003, 'forked'),
      checkpointRow(1002, 'forked'),
      checkpointRow(1001, 'forked'),
      checkpointRow(1000, 'h1000'),
    ]);
    stubRollback([1001, 1002, 1003, 1004], 1000);
    vi.spyOn(worker, 'fetchLedgerHeader').mockImplementation(async (sequence: number) => ({
      sequence,
      hash: sequence === 1000 ? 'h1000' : `fork-${sequence}`,
      parentHash: 'p',
    }));
    vi.spyOn((worker as any).server, 'getEvents').mockResolvedValue({
      events: [],
      latestLedger: 1010,
    } as never);

    await (worker as any).runPollCycle();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Reorg recovered'));
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).not.toHaveBeenCalled();
  });

  it('skips verification entirely when no contract is configured', async () => {
    delete process.env.STREAM_CONTRACT_ID;
    const worker = new SorobanEventWorker();
    (mockedPrisma.indexerState.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'singleton',
      lastLedger: 1000,
      lastCursor: 'cursor-1000',
    });
    vi.spyOn((worker as any).server, 'getEvents').mockResolvedValue({
      events: [],
      latestLedger: 1000,
    } as never);

    await (worker as any).runPollCycle();

    // No checkpoints read, so an indexer without a contract cannot pay the
    // verification round-trip on every cycle.
    expect(mockedPrisma.ledgerCheckpoint.findMany).not.toHaveBeenCalled();
    expect(mockedPrisma.indexerDeadLetterEvent.upsert).not.toHaveBeenCalled();
  });
});
