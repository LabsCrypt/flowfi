/**
 * Integration test for resetIndexer / replayFromLedger racing a concurrent
 * scheduled poll — Functional Edge Case #19 from the second-wave audit (#1293).
 *
 * Both `resetIndexer` and `replayFromLedger` are tested in isolation elsewhere,
 * but never interleaved with SorobanEventWorker's mutex-protected poll cycle.
 * This file fills that gap by simulating the exact scenario operators hit during
 * incident recovery: a live, running indexer whose scheduled poll is mid-flight
 * when an operator resets or replays.
 *
 * Acceptance criteria:
 *   - New test fails against current code (the race is real).
 *   - Once Functional Edge Case #19 is fixed, the test passes.
 *
 * The race (Functional Edge Case #19):
 *   1. SorobanEventWorker.poll() -> runExclusive -> fetchAndProcessEvents()
 *   2. fetchAndProcessEvents reads IndexerState.lastLedger (e.g. 200)
 *   3. fetchAndProcessEvents awaits server.getEvents (async network I/O)
 *   4.   ^ WINDOW: resetIndexer(50) is called, writing lastLedger=50
 *   5. fetchAndProcessEvents finishes, upserts lastLedger=200 (stale value
 *      captured in step 2, because processEvent error prevents ledger advance)
 *   6. Reset is lost - cursor is 200 instead of 50.
 *
 * Root cause: resetIndexer bypasses the worker's batchMutex, so its DB write
 * can be overwritten by a concurrent poll's cursor upsert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Deferred promise (for controlling async timing in tests) ─────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Shared mutable DB state ─────────────────────────────────────────────────
//
// Both the worker (via ensureIndexerState + upsert) and resetIndexer
// (via upsert) write to this shared state, simulating a real Postgres
// where concurrent upserts actually race.

let dbIndexerState: {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
};

// Track all upsert calls in order for forensic assertions.
const upsertLog: Array<{ lastLedger: number; lastCursor: string | null; caller: string }> = [];

// ─── Hoisted mock factories ──────────────────────────────────────────────────

const { mockPrisma, mockSseService, mockLogger } = vi.hoisted(() => {
  const mockPrisma = {
    indexerState: {
      upsert: vi.fn(async (args: any) => {
        const update = args.update ?? {};
        dbIndexerState = {
          ...dbIndexerState,
          ...update,
          updatedAt: new Date(),
        };
        const caller = update.lastCursor === null && update.lastLedger !== undefined
          ? 'resetIndexer'
          : 'worker';
        upsertLog.push({
          lastLedger: dbIndexerState.lastLedger,
          lastCursor: dbIndexerState.lastCursor,
          caller,
        });
        return { ...dbIndexerState };
      }),
    },
    $disconnect: vi.fn(),
  };

  return {
    mockPrisma,
    mockSseService: {
      broadcastToStream: vi.fn(),
      broadcastToAdmin: vi.fn(),
    },
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../src/lib/indexer-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/indexer-state.js')>();
  return {
    ...original,
    ensureIndexerState: vi.fn(async (_startLedger: number) => {
      return {
        id: 'singleton' as const,
        lastLedger: dbIndexerState.lastLedger,
        lastCursor: dbIndexerState.lastCursor,
        createdAt: new Date(),
        updatedAt: dbIndexerState.updatedAt,
      };
    }),
  };
});

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mockSseService,
}));

vi.mock('../../src/logger.js', () => ({
  default: mockLogger,
  requestContext: vi.fn(() => ({})),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SorobanEventWorker } from '../../src/workers/soroban-event-worker.js';
import { resetIndexer, replayFromLedger } from '../../src/services/indexerService.js';

/**
 * Build a minimal Soroban EventResponse that the worker can decode.
 * We use `stream_created` with the minimum required body fields so
 * `fetchAndProcessEvents` reaches the final cursor upsert.
 */
function fakeStreamCreatedEvent(overrides: {
  id: string;
  txHash: string;
  ledger: number;
}) {
  return {
    id: overrides.id,
    type: 'contract' as const,
    ledger: overrides.ledger,
    ledgerClosedAt: new Date().toISOString(),
    txHash: overrides.txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [
      {
        switch: () => ({ value: 0 }),
        sym: () => 'stream_created',
      },
      {
        switch: () => ({ value: 1 }),
        u64: () => ({ toString: () => '42' }),
      },
    ],
    value: {
      switch: () => ({ value: 4 }),
      map: () => [
        {
          key: () => ({ sym: () => 'sender' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 0 }),
              accountId: () => ({
                ed25519: () => Buffer.alloc(32),
              }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'recipient' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 0 }),
              accountId: () => ({
                ed25519: () => Buffer.alloc(32),
              }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'token_address' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 1 }),
              contractId: () => Buffer.alloc(32),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'rate_per_second' }),
          val: () => ({
            i128: () => ({
              hi: () => ({ toString: () => '0' }),
              lo: () => ({ toString: () => '100' }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'deposited_amount' }),
          val: () => ({
            i128: () => ({
              hi: () => ({ toString: () => '0' }),
              lo: () => ({ toString: () => '86400' }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'start_time' }),
          val: () => ({
            u64: () => ({ toString: () => '1700000000' }),
          }),
        },
      ],
    } as any,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Reset/replay race with concurrent poll (Edge Case #19 - issue #1293)', () => {
  let worker: SorobanEventWorker;
  let getEventsDeferred: Deferred<{ events: any[]; latestCursor?: string | null }>;

  beforeEach(() => {
    vi.clearAllMocks();
    upsertLog.length = 0;

    // Initialize shared DB state.
    dbIndexerState = {
      lastLedger: 0,
      lastCursor: null,
      updatedAt: new Date(),
    };

    worker = new SorobanEventWorker();
    (worker as any).contractId = 'CTESTCONTRACT';
    (worker as any).pollIntervalMs = 600_000;

    // Wire up deferred getEvents mock.
    getEventsDeferred = defer();
    const server = (worker as any).server as { getEvents: ReturnType<typeof vi.fn> };
    server.getEvents = vi.fn(() => getEventsDeferred.promise);
  });

  afterEach(() => {
    worker.stop();
  });

  it(
    'resetIndexer cursor must survive a concurrent scheduled poll - ' +
      'FAILS before fix (poll overwrites reset)',
    async () => {
      // ── Arrange ──────────────────────────────────────────────────────

      // Simulate: indexer is at ledger 200, poll starts reading from there.
      dbIndexerState = {
        lastLedger: 200,
        lastCursor: 'cursor-old',
        updatedAt: new Date(),
      };

      // ── Act ──────────────────────────────────────────────────────────

      // 1. Start the worker.  This calls poll() -> runExclusive ->
      //    fetchAndProcessEvents -> ensureIndexerState (reads lastLedger=200)
      //    -> server.getEvents (suspended on deferred promise).
      void worker.start();
      await new Promise((r) => setTimeout(r, 0));

      // 2. While the poll is suspended on getEvents, the operator calls
      //    resetIndexer(50).  This directly upserts the DB - no mutex.
      await resetIndexer(50);

      // Verify the DB now has lastLedger=50 (the reset).
      expect(dbIndexerState.lastLedger).toBe(50);

      // 3. Resolve getEvents with a real event so the poll reaches the
      //    cursor upsert at the end of fetchAndProcessEvents.
      //    The poll captured lastLedger=200 before the reset, so it will
      //    upsert lastLedger=200, overwriting the reset's 50.
      getEventsDeferred.resolve({
        events: [
          fakeStreamCreatedEvent({ id: 'e1', txHash: 'tx1', ledger: 210 }),
        ],
        latestCursor: 'cursor-new',
      });

      // Wait for the poll to fully complete.
      await worker.waitForDrain();

      // ── Assert ───────────────────────────────────────────────────────

      // The upsert log tells the story:
      //   1. resetIndexer writes lastLedger=50 (the operator's reset)
      //   2. Worker's fetchAndProcessEvents writes lastLedger=200 (stale!)
      //
      // The poll's upsert overwrites the reset because it captured
      // lastLedger=200 at the start and never re-read.
      expect(upsertLog.length).toBe(2);

      // First upsert: resetIndexer.
      expect(upsertLog[0]!.caller).toBe('resetIndexer');
      expect(upsertLog[0]!.lastLedger).toBe(50);

      // Second upsert: worker's stale cursor write.
      expect(upsertLog[1]!.caller).toBe('worker');
      expect(upsertLog[1]!.lastLedger).toBe(200);

      // Final DB state: the reset value (50) must survive.
      // This assertion asserts the DESIRED behavior.  Before the fix, it
      // fails because the poll's stale upsert (200) overwrites the reset.
      // After the fix, the poll must respect the externally-set cursor.
      expect(dbIndexerState.lastLedger).toBe(50);
    },
  );

  it(
    'replayFromLedger cursor must survive a concurrent scheduled poll - ' +
      'FAILS before fix (poll overwrites replay reset)',
    async () => {
      // ── Arrange ──────────────────────────────────────────────────────

      dbIndexerState = {
        lastLedger: 300,
        lastCursor: 'cursor-abc',
        updatedAt: new Date(),
      };

      // ── Act ──────────────────────────────────────────────────────────

      // 1. Start the worker - first poll reads lastLedger=300, awaits getEvents.
      void worker.start();
      await new Promise((r) => setTimeout(r, 0));

      // 2. Resolve the first poll's getEvents so it finishes.
      getEventsDeferred.resolve({
        events: [
          fakeStreamCreatedEvent({ id: 'e2', txHash: 'tx2', ledger: 310 }),
        ],
        latestCursor: 'cursor-first',
      });

      await worker.waitForDrain();

      // 3. Set up a new deferred for the SECOND poll.
      getEventsDeferred = defer();
      const server = (worker as any).server as { getEvents: ReturnType<typeof vi.fn> };
      server.getEvents = vi.fn(() => getEventsDeferred.promise);

      // 4. Start a second poll that will be mid-flight when we call
      //    replayFromLedger.
      void worker.start();
      await new Promise((r) => setTimeout(r, 0));

      // Second poll is now suspended at getEvents, having read lastLedger=300.

      // 5. Operator calls replayFromLedger(100):
      //    a) resetIndexer(100) -> upserts lastLedger=100
      //    b) triggerPoll() -> queued behind the second poll via mutex
      const replayPromise = replayFromLedger(100);

      // Yield to let resetIndexer(100) execute.
      await new Promise((r) => setTimeout(r, 0));

      // Verify resetIndexer wrote lastLedger=100.
      expect(dbIndexerState.lastLedger).toBe(100);

      // 6. Resolve the second poll's getEvents with a real event.
      //    The second poll will finish, upserting its stale lastLedger=300,
      //    overwriting the reset's 100.
      getEventsDeferred.resolve({
        events: [
          fakeStreamCreatedEvent({ id: 'e3', txHash: 'tx3', ledger: 320 }),
        ],
        latestCursor: 'cursor-poll2',
      });

      // The replay's triggerPoll will run after the second poll finishes.
      // Set up yet another deferred for the replay's poll.
      getEventsDeferred = defer();
      server.getEvents = vi.fn(() => getEventsDeferred.promise);

      // Yield so the replay's poll starts and suspends at getEvents.
      await new Promise((r) => setTimeout(r, 0));

      // Resolve the replay's poll with empty events (no more work to do).
      getEventsDeferred.resolve({
        events: [],
        latestCursor: 'cursor-replay',
      });

      // Wait for replay to fully complete.
      await replayPromise;
      await worker.waitForDrain();

      // ── Assert ───────────────────────────────────────────────────────

      // The upsert log tells the story:
      //   1. First poll writes 300 (event ledger, normal advancement)
      //   2. resetIndexer writes 100 (the operator's reset)
      //   3. Second poll writes 300 (stale - overwrites the reset!)
      //   4. Replay's poll writes whatever it read
      //
      // The key bug: step 3 overwrites step 2.
      expect(upsertLog.length).toBeGreaterThanOrEqual(3);

      // Find the resetIndexer upsert.
      const resetEntry = upsertLog.find((e) => e.caller === 'resetIndexer');
      expect(resetEntry).toBeDefined();
      expect(resetEntry!.lastLedger).toBe(100);

      // Final DB state: the reset value (100) must survive.
      // This assertion asserts the DESIRED behavior.  Before the fix, it
      // fails because the second poll's stale upsert (300) overwrites the reset.
      // After the fix, the poll must respect the externally-set cursor.
      expect(dbIndexerState.lastLedger).toBe(100);
    },
  );
});
