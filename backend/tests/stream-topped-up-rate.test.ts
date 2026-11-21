/**
 * Issue #1761 — top-up rate accounting in the Soroban event worker.
 *
 * These are characterization tests for `handleStreamToppedUp`, reached through
 * the public `processEvent` dispatch. They pin the documented success path
 * (derived `endTime`, stored-rate semantics, i128 precision), the failure
 * contract (`missing body fields`), dependency failures (missing `Stream` row)
 * and replay behaviour (event-row dedup keyed on `transactionHash`+`eventType`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';

// ─── In-memory fake of the tables the top-up path touches ────────────────────
interface FakeStream {
  streamId: bigint;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: bigint;
  endTime: bigint | null;
  lastUpdateTime: bigint;
  isActive: boolean;
  totalPausedDuration: number;
}

interface FakeStreamEvent {
  id: number;
  streamId: bigint;
  eventType: string;
  amount: string;
  transactionHash: string;
  ledgerSequence: number;
  /** `StreamEvent.timestamp` is a BigInt column; the writer passes `BigInt(...)`. */
  timestamp: bigint;
  metadata: string;
}

const fake = vi.hoisted(() => {
  const streams = new Map<bigint, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  const rowKey = (hash: string, type: string) => `${hash}|${type}`;
  let nextEventId = 1;

  const notFound = () => {
    const error = new Error('An operation failed because it depends on one or more records that were required but not found.');
    (error as Error & { code?: string }).code = 'P2025';
    return error;
  };

  const tx = {
    // `lockStreamForUpdate` (issue #1932) takes the row lock through raw SQL
    // before touching any amount. Tagged-template call, so the bound values
    // arrive after the strings array.
    $executeRaw: vi.fn(async (_strings: unknown, ...values: unknown[]) =>
      streams.has(BigInt(values[0] as bigint)) ? 1 : 0,
    ),
    stream: {
      findUniqueOrThrow: vi.fn(async (args: { where: { streamId: bigint } }) => {
        const row = streams.get(BigInt(args.where.streamId));
        if (!row) throw notFound();
        return { ...row };
      }),
      update: vi.fn(async (args: { where: { streamId: bigint }; data: Record<string, unknown> }) => {
        const row = streams.get(BigInt(args.where.streamId));
        if (!row) throw notFound();
        Object.assign(row, args.data);
        return row;
      }),
    },
    streamEvent: {
      findUnique: vi.fn(
        async (args: {
          where: { transactionHash_eventType: { transactionHash: string; eventType: string } };
          select?: Record<string, boolean>;
        }) => {
          const { transactionHash, eventType } = args.where.transactionHash_eventType;
          const row = events.get(rowKey(transactionHash, eventType));
          if (!row) return null;
          // Mirror Prisma's `select`: only the requested columns come back, so a
          // handler that reads a field it never asked for fails here, not in prod.
          const selected = args.select ?? { id: true };
          return Object.fromEntries(
            Object.keys(selected).map((field) => [field, row[field]]),
          );
        },
      ),
      upsert: vi.fn(
        async (args: {
          where: { transactionHash_eventType: { transactionHash: string; eventType: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const { transactionHash, eventType } = args.where.transactionHash_eventType;
          const key = rowKey(transactionHash, eventType);
          const existing = events.get(key);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          const created = { id: nextEventId++, ...args.create };
          events.set(key, created);
          return created;
        },
      ),
    },
  };

  return {
    streams,
    events,
    eventKey: rowKey,
    tx,
    // Same call shape as `prisma.$transaction`, including rollback of the
    // in-memory rows so a mid-transaction throw cannot leave a partial write.
    $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => {
      const streamBackup = new Map([...streams].map(([id, row]) => [id, { ...row }]));
      const eventBackup = new Map([...events].map(([key, row]) => [key, { ...row }]));
      const restore = () => {
        streams.clear();
        events.clear();
        for (const [id, row] of streamBackup) streams.set(id, row);
        for (const [key, row] of eventBackup) events.set(key, row);
      };
      try {
        return await cb(tx);
      } catch (error) {
        restore();
        throw error;
      }
    }),
    stream(id: bigint, overrides: Partial<FakeStream> = {}): FakeStream {
      const row: FakeStream = {
        streamId: id,
        ratePerSecond: '10',
        depositedAmount: '1000',
        withdrawnAmount: '0',
        startTime: 1700000000n,
        endTime: 1700000100n,
        lastUpdateTime: 1700000000n,
        isActive: true,
        totalPausedDuration: 0,
        ...overrides,
      };
      streams.set(id, row as unknown as Record<string, unknown>);
      return row;
    },
    reset() {
      streams.clear();
      events.clear();
      nextEventId = 1;
      vi.clearAllMocks();
    },
  };
});

vi.mock('../src/lib/prisma.js', () => ({
  default: { $transaction: fake.$transaction },
  prisma: { $transaction: fake.$transaction },
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

vi.mock('../src/services/sentinel.service.js', () => ({
  sentinelService: {
    recordWithdrawal: vi.fn(),
    recordStreamCreation: vi.fn(),
  },
}));

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  return {
    ...actual,
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { sseService } from '../src/services/sse.service.js';
import logger from '../src/logger.js';

// ─── ScVal fixtures (property-shaped, matching the on-chain XDR surface) ─────
const sym = (name: string) => ({ sym: { toString: () => name } });
const u64 = (value: number | bigint | string) => ({ u64: { toString: () => String(value) } });
const i128 = (hi: number | bigint | string, lo: number | bigint | string) => ({
  i128: { hi: { toString: () => String(hi) }, lo: { toString: () => String(lo) } },
});
const accountAddress = (bytes = Buffer.alloc(32, 7)) => ({
  address: { type: 'scAddressTypeAccount', accountId: { ed25519: { value: bytes } } },
});
const entry = (key: string, val: unknown) => ({ key: sym(key), val });
const mapOf = (entries: unknown[]) => ({ map: entries });

const START = 1700000000n;

interface TopUpBody {
  amount?: [number | string, number | string];
  newDeposited?: [number | string, number | string];
  newEndTime?: number | string;
  sender?: unknown;
}

/** `stream_topped_up` payload as the contract emits it (`StreamToppedUpEvent`). */
function topUpEvent(opts: { streamId?: number; txHash?: string; ledger?: number; body?: TopUpBody }) {
  const body: TopUpBody = opts.body ?? {};
  const entries: unknown[] = [entry('sender', body.sender ?? accountAddress())];
  if (body.amount) entries.push(entry('amount', i128(body.amount[0], body.amount[1])));
  if (body.newDeposited) entries.push(entry('new_deposited_amount', i128(body.newDeposited[0], body.newDeposited[1])));
  if (body.newEndTime !== undefined) entries.push(entry('new_end_time', u64(body.newEndTime)));

  return {
    id: `${opts.txHash ?? 'tx-topup'}-0`,
    type: 'contract',
    ledger: opts.ledger ?? 1234,
    ledgerClosedAt: '1700000500',
    txHash: opts.txHash ?? 'tx-topup',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [sym('stream_topped_up'), u64(opts.streamId ?? 42)],
    value: mapOf(entries),
  } as unknown as rpc.Api.EventResponse;
}

const defaultBody: TopUpBody = { amount: [0, 1100], newDeposited: [0, 2100], newEndTime: 1800000000 };

function toppedUpRow(streamId = 42n) {
  return fake.streams.get(streamId);
}
function eventRows() {
  return [...fake.events.values()] as unknown as FakeStreamEvent[];
}
function broadcastCalls() {
  return (sseService.broadcastToStream as ReturnType<typeof vi.fn>).mock.calls;
}

/**
 * The row `applyTopUpOnce` leaves behind when this API process confirms a
 * top-up before the indexer sees it: the real dedup key with the
 * `ledgerSequence = 0` marker meaning "chain position not known yet".
 */
function seedApiMarkerRow(opts: {
  txHash: string;
  amount: string;
  timestamp?: bigint;
  ledgerSequence?: number;
}) {
  const row: FakeStreamEvent = {
    id: 900,
    streamId: 42n,
    eventType: 'TOPPED_UP',
    amount: opts.amount,
    transactionHash: opts.txHash,
    ledgerSequence: opts.ledgerSequence ?? 0,
    timestamp: opts.timestamp ?? 1735689600n,
    metadata: '{}',
  };
  fake.events.set(fake.eventKey(opts.txHash, 'TOPPED_UP'), row as unknown as Record<string, unknown>);
  return row;
}

describe('SorobanEventWorker — stream_topped_up rate accounting (#1761)', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    fake.reset();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2025, 0, 1, 0, 0, 0));
    worker = new SorobanEventWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('documented success path', () => {
    it('derives endTime from startTime + deposited/rate and stores the new deposit', async () => {
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ body: defaultBody }));

      // 1700000000 + 2100/10 + 0 paused
      expect(toppedUpRow()).toMatchObject({
        depositedAmount: '2100',
        endTime: START + 210n,
      });
      // The single-writer contract (#1932): the row lock is taken before the
      // amount is read back, so a concurrent top-up cannot interleave.
      expect(fake.tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('writes exactly one TOPPED_UP StreamEvent keyed on txHash + eventType', async () => {
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ txHash: '0xabc', ledger: 555, body: defaultBody }));

      const [event] = eventRows();
      expect(eventRows()).toHaveLength(1);
      expect(event).toMatchObject({
        streamId: 42n,
        eventType: 'TOPPED_UP',
        amount: '1100',
        transactionHash: '0xabc',
        ledgerSequence: 555,
      });
      expect(JSON.parse(event!.metadata)).toEqual({ newDepositedAmount: '2100' });
    });

    it('adds totalPausedDuration back onto the derived endTime', async () => {
      fake.stream(42n, { totalPausedDuration: 120 });

      await worker.processEvent(topUpEvent({ body: defaultBody }));

      expect(toppedUpRow()?.endTime).toBe(START + 210n + 120n);
    });

    it('broadcasts stream.topped_up with the decoded i128 strings', async () => {
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ txHash: '0xabc', ledger: 555, body: defaultBody }));

      expect(broadcastCalls()).toEqual([
        [
          '42',
          'stream.topped_up',
          {
            streamId: 42n,
            amount: '1100',
            newDepositedAmount: '2100',
            transactionHash: '0xabc',
            ledger: 555,
            timestamp: 1735689600,
          },
        ],
      ]);
    });
  });

  describe('rate boundary inputs', () => {
    it('stores a null endTime when the stored rate is zero', async () => {
      fake.stream(42n, { ratePerSecond: '0' });

      await worker.processEvent(topUpEvent({ body: defaultBody }));

      expect(toppedUpRow()).toMatchObject({ endTime: null, depositedAmount: '2100' });
    });

    it('truncates fractional runway toward zero', async () => {
      // 10 / 3 = 3 seconds of runway, not 3.333 and not 4.
      fake.stream(42n, { ratePerSecond: '3' });

      await worker.processEvent(topUpEvent({ body: { amount: [0, 1], newDeposited: [0, 10] } }));

      expect(toppedUpRow()?.endTime).toBe(START + 3n);
    });

    it('keeps full integer precision above Number.MAX_SAFE_INTEGER', async () => {
      const beyondSafe = 9007199254740993n; // 2^53 + 1
      fake.stream(42n, { ratePerSecond: '1' });

      await worker.processEvent(
        topUpEvent({ body: { amount: [0, beyondSafe.toString()], newDeposited: [0, beyondSafe.toString()] } }),
      );

      expect(toppedUpRow()?.endTime).toBe(START + beyondSafe);
      expect(toppedUpRow()?.depositedAmount).toBe(beyondSafe.toString());
    });

    it('decodes an i128 amount that spans both 64-bit halves', async () => {
      fake.stream(42n);

      await worker.processEvent(
        topUpEvent({ body: { amount: [1, 0], newDeposited: [1, 0] } }),
      );

      expect(eventRows()[0]?.amount).toBe('18446744073709551616');
      expect(toppedUpRow()?.depositedAmount).toBe('18446744073709551616');
    });

    it('accepts a zero-amount top-up and still refreshes the deposit', async () => {
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ body: { amount: [0, 0], newDeposited: [0, 2100] } }));

      expect(toppedUpRow()).toMatchObject({ depositedAmount: '2100', endTime: START + 210n });
      expect(eventRows()[0]?.amount).toBe('0');
    });

    it('never rewrites ratePerSecond — the stored rate is the only input', async () => {
      fake.stream(42n, { ratePerSecond: '10' });

      await worker.processEvent(topUpEvent({ body: defaultBody }));

      const updateCall = (fake.tx.stream.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(updateCall.data).sort()).toEqual(['depositedAmount', 'endTime', 'lastUpdateTime']);
      expect(toppedUpRow()?.ratePerSecond).toBe('10');
    });

    it('ignores the chain-authoritative new_end_time in favour of the derived value', async () => {
      // The contract ships `new_end_time` on this very event; the worker's
      // derivation wins, so a stale stored rate silently propagates here.
      fake.stream(42n, { ratePerSecond: '10' });

      await worker.processEvent(topUpEvent({ body: { ...defaultBody, newEndTime: 1800000000 } }));

      expect(toppedUpRow()?.endTime).toBe(START + 210n);
      expect(toppedUpRow()?.endTime).not.toBe(1800000000n);
    });

    it('leaves the rate untouched when the contract emits stream_rate_modified', async () => {
      const row = fake.stream(42n, { ratePerSecond: '10' });

      await worker.processEvent({
        id: 'rate-1',
        ledger: 1235,
        ledgerClosedAt: '1700000600',
        txHash: 'tx-rate',
        topic: [sym('stream_rate_modified'), u64(42)],
        value: mapOf([entry('new_rate_per_second', i128(0, 99)), entry('new_end_time', u64(1900000000))]),
      } as unknown as rpc.Api.EventResponse);

      expect(row.ratePerSecond).toBe('10');
      expect(fake.$transaction).not.toHaveBeenCalled();
      expect(broadcastCalls()).toHaveLength(0);
    });
  });

  describe('failure contract', () => {
    it('rejects when amount is absent from the event body', async () => {
      fake.stream(42n);

      await expect(
        worker.processEvent(topUpEvent({ body: { newDeposited: [0, 2100] } })),
      ).rejects.toThrow('StreamToppedUp #42: missing body fields');

      expect(fake.tx.stream.update).not.toHaveBeenCalled();
      expect(eventRows()).toHaveLength(0);
      expect(broadcastCalls()).toHaveLength(0);
    });

    it('rejects when new_deposited_amount is absent from the event body', async () => {
      fake.stream(42n);

      await expect(
        worker.processEvent(topUpEvent({ body: { amount: [0, 1100] } })),
      ).rejects.toThrow('StreamToppedUp #42: missing body fields');

      expect(fake.tx.stream.update).not.toHaveBeenCalled();
    });

    it('propagates P2025 and writes nothing when the Stream row is missing', async () => {
      await expect(worker.processEvent(topUpEvent({ body: defaultBody }))).rejects.toMatchObject({
        code: 'P2025',
      });

      expect(fake.tx.stream.update).not.toHaveBeenCalled();
      expect(eventRows()).toHaveLength(0);
      expect(broadcastCalls()).toHaveLength(0);
    });

    it('propagates a transaction failure raised by the event-row write', async () => {
      fake.stream(42n);
      (fake.tx.streamEvent.upsert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('connection terminated'),
      );

      await expect(worker.processEvent(topUpEvent({ body: defaultBody }))).rejects.toThrow(
        'connection terminated',
      );

      // The fake rolls back like `prisma.$transaction`, so the deposit is intact.
      expect(toppedUpRow()?.depositedAmount).toBe('1000');
      expect(broadcastCalls()).toHaveLength(0);
    });

    it('ignores a top-up event that carries no stream id topic', async () => {
      fake.stream(42n);

      await worker.processEvent({
        id: 'truncated',
        ledger: 1236,
        ledgerClosedAt: '1700000700',
        txHash: 'tx-truncated',
        topic: [sym('stream_topped_up')],
        value: mapOf([entry('amount', i128(0, 1)), entry('new_deposited_amount', i128(0, 2))]),
      } as unknown as rpc.Api.EventResponse);

      expect(fake.$transaction).not.toHaveBeenCalled();
      expect(broadcastCalls()).toHaveLength(0);
    });
  });

  describe('replay idempotency', () => {
    it('skips the second delivery of the same txHash without re-applying the top-up', async () => {
      fake.stream(42n);
      const event = topUpEvent({ txHash: '0xdead', body: defaultBody });

      await worker.processEvent(event);
      await worker.processEvent(event);

      expect(eventRows()).toHaveLength(1);
      expect(toppedUpRow()).toMatchObject({ depositedAmount: '2100', endTime: START + 210n });
      expect(fake.tx.stream.update).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate StreamEvent skipped: txHash=0xdead type=TOPPED_UP'),
      );
    });

    it('re-broadcasts SSE for a replayed event even though the write is skipped', async () => {
      fake.stream(42n);
      const event = topUpEvent({ txHash: '0xdead', body: defaultBody });

      await worker.processEvent(event);
      await worker.processEvent(event);

      expect(broadcastCalls()).toHaveLength(2);
    });

    it('treats the same stream id in a different transaction as a fresh top-up', async () => {
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ txHash: '0x1', body: { amount: [0, 100], newDeposited: [0, 1100] } }));
      await worker.processEvent(topUpEvent({ txHash: '0x2', body: { amount: [0, 1000], newDeposited: [0, 2100] } }));

      expect(eventRows()).toHaveLength(2);
      expect(toppedUpRow()?.endTime).toBe(START + 210n);
    });
  });

  describe('reconciling the marker row the API writer leaves behind', () => {
    it('assigns the chain total instead of adding its own delta on top of it', async () => {
      // `applyTopUpOnce` already credited 2100 and stored the top-up with
      // ledgerSequence 0; re-applying the 1100 delta here would overcount the
      // stream permanently.
      fake.stream(42n, { depositedAmount: '2100', endTime: START + 210n });
      seedApiMarkerRow({ txHash: '0xapi', amount: '1100' });

      await worker.processEvent(topUpEvent({ txHash: '0xapi', ledger: 555, body: defaultBody }));

      expect(toppedUpRow()).toMatchObject({ depositedAmount: '2100', endTime: START + 210n });
      expect(fake.tx.stream.update).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Reconciling API-applied top-up against chain: txHash=0xapi'),
      );
    });

    it('overwrites the deposit with the chain value when the two disagree', async () => {
      fake.stream(42n, { depositedAmount: '2100' });
      seedApiMarkerRow({ txHash: '0xapi', amount: '1100' });

      await worker.processEvent(
        topUpEvent({ txHash: '0xapi', ledger: 555, body: { amount: [0, 1050], newDeposited: [0, 2050] } }),
      );

      expect(toppedUpRow()?.depositedAmount).toBe('2050');
      expect(toppedUpRow()?.endTime).toBe(START + 205n);
    });

    it('fills the ledger position into the existing row instead of writing a second one', async () => {
      fake.stream(42n, { depositedAmount: '2100' });
      const marker = seedApiMarkerRow({ txHash: '0xapi', amount: '1100' });

      await worker.processEvent(topUpEvent({ txHash: '0xapi', ledger: 555, body: defaultBody }));

      expect(eventRows()).toHaveLength(1);
      expect(marker.ledgerSequence).toBe(555);
    });

    it('still skips a row the indexer itself wrote, which is any non-zero ledger position', async () => {
      fake.stream(42n, { depositedAmount: '2100' });
      seedApiMarkerRow({ txHash: '0xapi', amount: '1100', ledgerSequence: 444 });

      await worker.processEvent(
        topUpEvent({ txHash: '0xapi', ledger: 555, body: { amount: [0, 9000], newDeposited: [0, 9999] } }),
      );

      expect(fake.tx.stream.update).not.toHaveBeenCalled();
      expect(toppedUpRow()).toMatchObject({ depositedAmount: '2100' });
      expect(eventRows()[0]?.ledgerSequence).toBe(444);
    });
  });

  describe('timestamp semantics', () => {
    it('stamps lastUpdateTime with processing time, not the ledger close time', async () => {
      // The event's ledgerClosedAt decodes to 1700000500; this handler is the
      // only one of the family that ignores it.
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ body: defaultBody }));

      expect(toppedUpRow()?.lastUpdateTime).toBe(1735689600);
      expect(eventRows()[0]?.timestamp).toBe(1735689600n);
    });

    it('advances the stamp when a later top-up is processed in a later wall-clock second', async () => {
      fake.stream(42n);

      await worker.processEvent(topUpEvent({ txHash: '0x1', body: { amount: [0, 1], newDeposited: [0, 1001] } }));
      vi.setSystemTime(Date.UTC(2025, 0, 1, 0, 1, 0));
      await worker.processEvent(topUpEvent({ txHash: '0x2', body: { amount: [0, 1], newDeposited: [0, 1002] } }));

      expect(toppedUpRow()?.lastUpdateTime).toBe(1735689660);
      expect(eventRows().map((row) => row.timestamp)).toEqual([1735689600n, 1735689660n]);
    });
  });
});
