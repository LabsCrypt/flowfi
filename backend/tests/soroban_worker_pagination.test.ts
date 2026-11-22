import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { StrKey, rpc, xdr } from '@stellar/stellar-sdk';

/**
 * Ledger pagination and cursor advancement in the event indexer (#1756).
 *
 * NOTE: the issue text points at `src/services/soroban-indexer.service.ts`,
 * which does not exist in this repo; the pagination and cursor logic it
 * describes lives in `src/workers/soroban-event-worker.ts`
 * (`fetchLedgerHeaders` / `fetchLedgerHeader` / `runPollCycle`).
 *
 * `tests/soroban-event-worker.test.ts` covers the per-event handlers — how a
 * `stream_created` payload is decoded and written. What is pinned here is the
 * ledger-walking contract around them: how many RPC pages a range costs, when a
 * walk gives up, which pagination parameter the next `getEvents` is built from,
 * and exactly which cursor survives a batch in which nothing (or only part of
 * what) could be processed.
 *
 * Event handling is stubbed at `processEvent` so that cursor semantics are
 * tested independently of payload decoding, and the reorg verifier is stubbed so
 * the poll cycle can be driven without a checkpoint table.
 */

const hoisted = vi.hoisted(() => ({
  prisma: {
    indexerState: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    ledgerCheckpoint: { findMany: vi.fn(), upsert: vi.fn() },
    streamEvent: { findUnique: vi.fn(), upsert: vi.fn() },
    user: { upsert: vi.fn() },
    stream: { upsert: vi.fn(), findUniqueOrThrow: vi.fn() },
    indexerDeadLetterEvent: { upsert: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
  checkpoint: {
    computeStateRootHash: vi.fn(() => 'state-root-hash'),
    recordCheckpoint: vi.fn(async () => undefined),
    verifyAndRecover: vi.fn(async () => ({ detected: false })),
  },
  indexer: {
    publishIndexerLag: vi.fn(),
    quarantineEvent: vi.fn(async () => undefined),
  },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/lib/prisma.js', () => ({
  default: hoisted.prisma,
  prisma: hoisted.prisma,
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

vi.mock('../src/services/checkpoint.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/checkpoint.service.js')>();
  return { ...actual, ...hoisted.checkpoint };
});

vi.mock('../src/services/indexerService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/indexerService.js')>();
  return { ...actual, ...hoisted.indexer };
});

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  return { ...actual, default: hoisted.logger };
});

import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { indexerPollsTotal } from '../src/lib/metrics.js';
import {
  computeStateRootHash,
  recordCheckpoint,
  verifyAndRecover,
} from '../src/services/checkpoint.service.js';

const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));

/** Replace one RPC method on the worker's server, typed as a bare mock. */
function spyServerMethod(worker: SorobanEventWorker, method: 'getEvents' | 'getLedgers'): Mock {
  const server = (worker as unknown as { server: Record<string, unknown> }).server;
  return vi.spyOn(server as Record<string, Mock>, method) as unknown as Mock;
}

async function counterValue(counter: unknown, labels: Record<string, string>): Promise<number> {
  const metric = await (
    counter as { get: () => Promise<{ values?: Array<{ value: number; labels?: Record<string, string> }> }> }
  ).get();
  return (metric?.values ?? [])
    .filter((value) => Object.entries(labels).every(([name, want]) => value.labels?.[name] === want))
    .reduce((sum, value) => sum + value.value, 0);
}

const sym = (name: string) => ({ sym: { toString: () => name } }) as unknown as xdr.ScVal;

interface EventSpec {
  id: string;
  ledger: number;
  name?: string;
  successful?: boolean;
  txHash?: string;
}

function makeEvent(spec: EventSpec): rpc.Api.EventResponse {
  return {
    id: spec.id,
    type: 'contract',
    ledger: spec.ledger,
    ledgerClosedAt: '1700000000',
    txHash: spec.txHash ?? `${spec.id}-tx`,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: spec.successful ?? true,
    topic: [sym(spec.name ?? 'stream_created'), sym('ignored')],
    value: {} as unknown as xdr.ScVal,
  } as rpc.Api.EventResponse;
}

function eventsResponse(
  events: rpc.Api.EventResponse[],
  extras: Record<string, unknown> = {},
): rpc.Api.GetEventsResponse {
  return {
    latestLedger: 1000,
    events,
    latestCursor: 'rpc-cursor-1000',
    ...extras,
  } as unknown as rpc.Api.GetEventsResponse;
}

/** One ledger entry as the RPC returns it, minus the XDR we do not need to decode. */
function ledgerEntry(sequence: number, headerXdr?: unknown) {
  return {
    sequence,
    hash: `hash-${sequence}`,
    ledgerCloseTime: '1700000000',
    headerXdr: headerXdr ?? { header: { previousLedgerHash: () => Buffer.alloc(32, sequence) } },
  };
}

interface LedgerFixture {
  sequence: number;
  hash: string;
  headerXdr?: unknown;
}

function ledgersResponse(entries: LedgerFixture[]) {
  return { ledgers: entries } as unknown as rpc.Api.GetLedgersResponse;
}

describe('ledger pagination and indexer cursor (#1756)', () => {
  let worker: SorobanEventWorker;
  let getEvents: Mock;
  let getLedgers: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.STREAM_CONTRACT_ID = contractId;
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.INDEXER_START_LEDGER = '500';

    worker = new SorobanEventWorker();
    getEvents = spyServerMethod(worker, 'getEvents');
    getLedgers = spyServerMethod(worker, 'getLedgers');

    hoisted.prisma.indexerState.findUnique.mockResolvedValue(null);
    hoisted.prisma.indexerState.create.mockResolvedValue({
      id: 'singleton',
      lastLedger: 500,
      lastCursor: null,
    });
    hoisted.prisma.indexerState.upsert.mockResolvedValue({ id: 'singleton' });
    getLedgers.mockResolvedValue(ledgersResponse([]));
    getEvents.mockResolvedValue(eventsResponse([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.INDEXER_START_LEDGER;
  });

  /** Persisted indexer state for the next cycle. */
  function withState(lastLedger: number, lastCursor: string | null): void {
    hoisted.prisma.indexerState.findUnique.mockResolvedValue({
      id: 'singleton',
      lastLedger,
      lastCursor,
    });
  }

  describe('fetchLedgerHeaders', () => {
    it('walks a 250-ledger range in three pages and asks for what remains', async () => {
      let next = 1;
      getLedgers.mockImplementation(async (params: { startLedger: number; pagination: { limit: number } }) => {
        const count = Math.min(params.pagination.limit, 250 - params.startLedger + 1);
        const entries = Array.from({ length: count }, (_, i) =>
          ledgerEntry(params.startLedger + i),
        );
        next = params.startLedger + count;
        return ledgersResponse(entries);
      });

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(1, 250);

      expect(headers.size).toBe(250);
      const calls = getLedgers.mock.calls.map((call) => call[0] as { startLedger: number; pagination: { limit: number } });
      expect(calls.map((c) => [c.startLedger, c.pagination.limit])).toEqual([
        [1, 100],
        [101, 100],
        [201, 50],
      ]);
      // Nothing beyond the requested window is fetched.
      expect(next).toBe(251);
    });

    it('clamps the page limit to the size of a short range', async () => {
      getLedgers.mockResolvedValue(
        ledgersResponse([ledgerEntry(500), ledgerEntry(501), ledgerEntry(502), ledgerEntry(503)]),
      );

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(500, 503);

      expect(headers.size).toBe(4);
      expect(getLedgers).toHaveBeenCalledTimes(1);
      expect(getLedgers.mock.calls[0]![0]).toEqual({ startLedger: 500, pagination: { limit: 4 } });
    });

    it('stops after an empty page instead of looping to the end of the range', async () => {
      getLedgers.mockResolvedValue(ledgersResponse([]));

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(10, 10_000);

      expect(headers.size).toBe(0);
      expect(getLedgers).toHaveBeenCalledTimes(1);
    });

    it('stops when a page does not advance past the requested start', async () => {
      // A node that ignores `startLedger` and replays the same ledger would
      // otherwise spin forever inside the poll cycle.
      getLedgers.mockResolvedValue(ledgersResponse([ledgerEntry(7)]));

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(10, 10_000);

      expect([...headers.keys()]).toEqual([7]);
      expect(getLedgers).toHaveBeenCalledTimes(1);
    });

    it('returns nothing for an inverted range without spending an RPC call', async () => {
      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(10, 9);

      expect(headers.size).toBe(0);
      expect(getLedgers).not.toHaveBeenCalled();
    });

    it('clamps a negative start ledger to zero', async () => {
      getLedgers.mockResolvedValue(ledgersResponse([ledgerEntry(0), ledgerEntry(1), ledgerEntry(2)]));

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(-5, 2);

      expect(getLedgers.mock.calls[0]![0]).toEqual({ startLedger: 0, pagination: { limit: 3 } });
      expect([...headers.keys()]).toEqual([0, 1, 2]);
    });

    it('survives a page that omits the ledgers field', async () => {
      getLedgers.mockResolvedValue({ latestLedger: 10 } as unknown as rpc.Api.GetLedgersResponse);

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, unknown>>;
      }).fetchLedgerHeaders(1, 5);

      expect(headers.size).toBe(0);
      expect(getLedgers).toHaveBeenCalledTimes(1);
    });

    it('links each header to its parent hash when the header is decodable', async () => {
      const parent = Buffer.alloc(32, 9).toString('hex');
      getLedgers.mockResolvedValue(
        ledgersResponse([
          {
            sequence: 41,
            hash: 'hash-41',
            headerXdr: { header: { previousLedgerHash: () => Buffer.alloc(32, 9) } },
          },
        ]),
      );

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, { parentHash: string }>>;
      }).fetchLedgerHeaders(41, 41);

      expect(headers.get(41)!.parentHash).toBe(parent);
    });

    it('leaves the parent hash empty for an undecodable header', async () => {
      // KNOWN GAP, asserted so a fix is visible: the RPC serves `headerXdr` as a
      // base64 string, which `extractParentLedgerHash` does not parse, so every
      // production header takes this branch and the checkpoint falls back to the
      // previous ledger's own hash (see the checkpoint test below).
      getLedgers.mockResolvedValue(ledgersResponse([{ sequence: 42, hash: 'hash-42', headerXdr: 'AAAAAg==' }]));

      const headers = await (worker as unknown as {
        fetchLedgerHeaders: (a: number, b: number) => Promise<Map<number, { parentHash: string }>>;
      }).fetchLedgerHeaders(42, 42);

      expect(headers.get(42)).toEqual({ sequence: 42, hash: 'hash-42', parentHash: '' });
    });

    it('reads one header per ledger through fetchLedgerHeader', async () => {
      getLedgers.mockResolvedValue(ledgersResponse([{ sequence: 999, hash: 'hash-999' }]));

      const header = await worker.fetchLedgerHeader(999);

      expect(header).toEqual({ sequence: 999, hash: 'hash-999', parentHash: '' });
      expect(getLedgers.mock.calls[0]![0]).toEqual({ startLedger: 999, pagination: { limit: 1 } });
    });

    it('resolves a pruned ledger to null rather than throwing', async () => {
      getLedgers.mockResolvedValue(ledgersResponse([{ sequence: 5, hash: 'hash-5' }]));

      await expect(worker.fetchLedgerHeader(999)).resolves.toBeNull();
    });
  });

  describe('getEvents request shape', () => {
    it('starts from INDEXER_START_LEDGER when there is no cursor and no history', async () => {
      withState(0, null);

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      const params = getEvents.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.startLedger).toBe(500);
      expect('cursor' in params).toBe(false);
      expect(params.filters).toEqual([{ type: 'contract', contractIds: [contractId] }]);
      expect(params.limit).toBe(100);
    });

    it('resumes from the persisted ledger when the cursor is missing', async () => {
      withState(640, null);

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      const params = getEvents.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.startLedger).toBe(640);
      expect('cursor' in params).toBe(false);
    });

    it('paginates by cursor alone once one is stored', async () => {
      withState(640, 'cursor-640-3');

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      const params = getEvents.mock.calls[0]![0] as Record<string, unknown>;
      // The RPC rejects a request that supplies both.
      expect(params.cursor).toBe('cursor-640-3');
      expect('startLedger' in params).toBe(false);
    });

    it('reports an rpc_error poll and leaves the cursor untouched when getEvents fails', async () => {
      withState(640, 'cursor-640-3');
      getEvents.mockRejectedValue(new Error('ETIMEDOUT soroban rpc'));
      const before = await counterValue(indexerPollsTotal, { outcome: 'rpc_error' });

      await expect(
        (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents(),
      ).rejects.toThrow('ETIMEDOUT soroban rpc');

      expect(await counterValue(indexerPollsTotal, { outcome: 'rpc_error' })).toBe(before + 1);
      expect(hoisted.prisma.indexerState.upsert).not.toHaveBeenCalled();
    });

    it('counts an empty batch as an empty poll without writing state', async () => {
      withState(700, 'cursor-700-1');
      getEvents.mockResolvedValue(eventsResponse([], { latestLedger: 712 }));
      const before = await counterValue(indexerPollsTotal, { outcome: 'empty' });

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(await counterValue(indexerPollsTotal, { outcome: 'empty' })).toBe(before + 1);
      expect(hoisted.prisma.indexerState.upsert).not.toHaveBeenCalled();
      expect(hoisted.indexer.publishIndexerLag).toHaveBeenCalledWith(700, 712);
    });

    it('treats a missing latestLedger as zero lag rather than NaN', async () => {
      withState(700, null);
      getEvents.mockResolvedValue(
        eventsResponse([], { latestLedger: undefined }) as unknown as rpc.Api.GetEventsResponse,
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(hoisted.indexer.publishIndexerLag).toHaveBeenCalledWith(700, 0);
    });
  });

  describe('cursor advancement', () => {
    /** Stub the handler seam so only cursor semantics are under test. */
    function stubProcessing(failFor: (event: rpc.Api.EventResponse) => boolean): void {
      vi.spyOn(worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> }, 'processEvent').mockImplementation(
        async (event) => {
          if (failFor(event)) throw new Error(`cannot handle ${event.id}`);
        },
      );
    }

    function persistedState(): { lastLedger: number; lastCursor: string | null } {
      const call = hoisted.prisma.indexerState.upsert.mock.calls.at(-1);
      return call?.[0].update as { lastLedger: number; lastCursor: string | null };
    }

    it('keeps the previous cursor when every event in the batch fails', async () => {
      withState(900, 'cursor-900-9');
      stubProcessing(() => true);
      getEvents.mockResolvedValue(
        eventsResponse([makeEvent({ id: 'e1', ledger: 901 }), makeEvent({ id: 'e2', ledger: 902 })]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(persistedState()).toEqual({ lastLedger: 900, lastCursor: 'cursor-900-9' });
      expect(hoisted.indexer.quarantineEvent).toHaveBeenCalledTimes(2);
    });

    it('keeps processing past a poison pill instead of halting the batch', async () => {
      withState(900, 'cursor-900-9');
      stubProcessing((event) => event.id === 'e2');
      getEvents.mockResolvedValue(
        eventsResponse([
          makeEvent({ id: 'e1', ledger: 901 }),
          makeEvent({ id: 'e2', ledger: 902 }),
          makeEvent({ id: 'e3', ledger: 903 }),
        ]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      // One failure quarantines one event; the batch continues and the ledger
      // lands on the last event that actually succeeded.
      expect(hoisted.indexer.quarantineEvent).toHaveBeenCalledTimes(1);
      expect(persistedState().lastLedger).toBe(903);
    });

    it('does not advance the ledger onto a failing event', async () => {
      withState(900, 'cursor-900-9');
      stubProcessing((event) => event.id === 'e2');
      getEvents.mockResolvedValue(
        eventsResponse([makeEvent({ id: 'e1', ledger: 901 }), makeEvent({ id: 'e2', ledger: 902 })]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(persistedState()).toEqual({ lastLedger: 901, lastCursor: 'rpc-cursor-1000' });
    });

    it('prefers the response cursor over the last processed event', async () => {
      withState(900, 'cursor-900-9');
      stubProcessing(() => false);
      getEvents.mockResolvedValue(
        eventsResponse([makeEvent({ id: 'e1', ledger: 901 })], { latestCursor: 'latest-1000-7' }),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(persistedState().lastCursor).toBe('latest-1000-7');
    });

    it('falls back to the last processed event id when the response has no cursor', async () => {
      withState(900, null);
      stubProcessing(() => false);
      getEvents.mockResolvedValue(
        eventsResponse([makeEvent({ id: 'e1', ledger: 901 })], { latestCursor: undefined }),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(persistedState()).toEqual({ lastLedger: 901, lastCursor: 'e1' });
    });

    it('does not advance past an event whose contract call reverted', async () => {
      withState(900, 'cursor-900-9');
      const processSpy = vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      );
      getEvents.mockResolvedValue(
        eventsResponse([
          makeEvent({ id: 'e1', ledger: 901, successful: false }),
          makeEvent({ id: 'e2', ledger: 902, successful: false }),
        ]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(processSpy).not.toHaveBeenCalled();
      expect(hoisted.indexer.quarantineEvent).not.toHaveBeenCalled();
      expect(persistedState()).toEqual({ lastLedger: 900, lastCursor: 'cursor-900-9' });
    });

    it('indexes stream_created before the events that depend on it', async () => {
      withState(900, null);
      const order: string[] = [];
      vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      ).mockImplementation(async (event) => {
        order.push(event.id);
      });
      getEvents.mockResolvedValue(
        eventsResponse([
          makeEvent({ id: 'fee', ledger: 901, name: 'fee_collected' }),
          makeEvent({ id: 'created', ledger: 901, name: 'stream_created' }),
          makeEvent({ id: 'withdraw', ledger: 902, name: 'tokens_withdrawn' }),
        ]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(order[0]).toBe('created');
      expect(order).toHaveLength(3);
    });

    it('creates the state row on first persistence', async () => {
      withState(0, null);
      stubProcessing(() => false);
      getEvents.mockResolvedValue(eventsResponse([makeEvent({ id: 'e1', ledger: 901 })]));

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      const call = hoisted.prisma.indexerState.upsert.mock.calls.at(-1)![0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(call.create).toEqual({ id: 'singleton', lastLedger: 901, lastCursor: 'rpc-cursor-1000' });
    });

    it('hands the reorg verifier a fetcher that reads exactly one ledger', async () => {
      withState(900, 'cursor-900-9');
      (verifyAndRecover as unknown as Mock).mockImplementation(
        async (fetch: (sequence: number) => Promise<unknown>) => {
          getLedgers.mockResolvedValue(ledgersResponse([{ sequence: 900, hash: 'hash-900' }]));
          await fetch(900);
          return { detected: false };
        },
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(verifyAndRecover).toHaveBeenCalledTimes(1);
      expect(getLedgers.mock.calls.at(-1)![0]).toEqual({ startLedger: 900, pagination: { limit: 1 } });
    });

    it('re-reads the cursor after a recovery rolls the chain back', async () => {
      withState(900, 'cursor-900-9');
      hoisted.prisma.indexerState.findUnique
        .mockResolvedValueOnce({ id: 'singleton', lastLedger: 900, lastCursor: 'cursor-900-9' })
        .mockResolvedValueOnce({ id: 'singleton', lastLedger: 880, lastCursor: 'cursor-880-1' });
      (verifyAndRecover as unknown as Mock).mockResolvedValue({
        detected: true,
        rollback: { safeLedger: 880, rolledBack: 3 },
      } as never);
      stubProcessing(() => false);

      const second = makeEvent({ id: 'e881', ledger: 881 });
      getEvents.mockResolvedValue(eventsResponse([second]));

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      // The stale fork's cursor must not be sent to the RPC again.
      const params = getEvents.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.cursor).toBe('cursor-880-1');
      expect(hoisted.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Reorg recovered'),
      );
    });

    it('keeps indexing when reorg verification itself throws', async () => {
      withState(900, 'cursor-900-9');
      (verifyAndRecover as unknown as Mock).mockRejectedValue(new Error('checkpoint table missing'));
      stubProcessing(() => false);
      getEvents.mockResolvedValue(eventsResponse([makeEvent({ id: 'e1', ledger: 901 })]));

      await expect(
        (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents(),
      ).resolves.toBeUndefined();

      expect(hoisted.logger.error).toHaveBeenCalledWith(
        '[SorobanWorker] Ledger checkpoint verification failed:',
        expect.any(Error),
      );
      expect(persistedState().lastLedger).toBe(901);
    });
  });

  describe('checkpoint recording around pagination', () => {
    it('fetches one ledger below the window so the oldest checkpoint has a parent', async () => {
      withState(900, null);
      vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      ).mockResolvedValue(undefined);
      getEvents.mockResolvedValue(
        eventsResponse([
          makeEvent({ id: 'e1', ledger: 901 }),
          makeEvent({ id: 'e2', ledger: 903, name: 'tokens_withdrawn' }),
        ]),
      );
      getLedgers.mockResolvedValue(
        ledgersResponse([
          { sequence: 900, hash: 'hash-900' },
          { sequence: 901, hash: 'hash-901' },
          { sequence: 903, hash: 'hash-903' },
        ]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(getLedgers.mock.calls[0]![0]).toEqual({ startLedger: 900, pagination: { limit: 4 } });
      const sequences = (recordCheckpoint as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.map(
        (call) => call[0].sequence,
      );
      expect(sequences).toEqual([901, 903]);
    });

    it('links a checkpoint to the previous ledger hash when the header has no parent', async () => {
      withState(900, null);
      vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      ).mockResolvedValue(undefined);
      getEvents.mockResolvedValue(eventsResponse([makeEvent({ id: 'e1', ledger: 901 })]));
      getLedgers.mockResolvedValue(
        ledgersResponse([
          { sequence: 900, hash: 'hash-900' },
          { sequence: 901, hash: 'hash-901' },
        ]),
      );

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(recordCheckpoint).toHaveBeenCalledWith({
        sequence: 901,
        hash: 'hash-901',
        parentHash: 'hash-900',
        eventsCount: 1,
        stateRootHash: computeStateRootHash([]),
      });
    });

    it('records nothing and still advances the cursor when headers cannot be fetched', async () => {
      withState(900, null);
      vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      ).mockResolvedValue(undefined);
      getEvents.mockResolvedValue(eventsResponse([makeEvent({ id: 'e1', ledger: 901 })]));
      getLedgers.mockRejectedValue(new Error('getLedgers not served by this node'));

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(recordCheckpoint).not.toHaveBeenCalled();
      expect(hoisted.logger.warn).toHaveBeenCalledWith(
        '[SorobanWorker] Unable to fetch ledger headers for checkpoints:',
        expect.any(Error),
      );
      const update = hoisted.prisma.indexerState.upsert.mock.calls.at(-1)![0] as {
        update: { lastLedger: number };
      };
      expect(update.update.lastLedger).toBe(901);
    });

    it('does not record a checkpoint for a ledger the RPC did not return', async () => {
      withState(900, null);
      vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      ).mockResolvedValue(undefined);
      getEvents.mockResolvedValue(eventsResponse([makeEvent({ id: 'e1', ledger: 901 })]));
      getLedgers.mockResolvedValue(ledgersResponse([{ sequence: 900, hash: 'hash-900' }]));

      await (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents();

      expect(recordCheckpoint).not.toHaveBeenCalled();
    });

    it('survives a checkpoint write failure', async () => {
      withState(900, null);
      vi.spyOn(
        worker as unknown as { processEvent: (e: rpc.Api.EventResponse) => Promise<void> },
        'processEvent',
      ).mockResolvedValue(undefined);
      getEvents.mockResolvedValue(eventsResponse([makeEvent({ id: 'e1', ledger: 901 })]));
      getLedgers.mockResolvedValue(
        ledgersResponse([{ sequence: 900, hash: 'hash-900' }, { sequence: 901, hash: 'hash-901' }]),
      );
      (recordCheckpoint as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
        new Error('checkpoint unique constraint'),
      );

      await expect(
        (worker as unknown as { fetchAndProcessEvents: () => Promise<void> }).fetchAndProcessEvents(),
      ).resolves.toBeUndefined();

      const update = hoisted.prisma.indexerState.upsert.mock.calls.at(-1)![0] as {
        update: { lastLedger: number };
      };
      expect(update.update.lastLedger).toBe(901);
    });
  });
});
