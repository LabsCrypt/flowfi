/**
 * Issue #1763 — completion events arriving before / after the final withdrawal,
 * and replay of a completion, in the Soroban event worker.
 *
 * Characterization tests for `handleStreamCompleted` reached through the public
 * `processEvent` dispatch, including the documented failure contract
 * (`missing body fields`), the dependency failure where the `Stream` row is
 * gone, and how the completion's authoritative `withdrawnAmount` interacts with
 * the incrementing `tokens_withdrawn` handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rpc, StrKey } from '@stellar/stellar-sdk';

interface FakeStream {
  streamId: bigint;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  tokenAddress: string;
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
  timestamp: number;
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
        async (args: { where: { transactionHash_eventType: { transactionHash: string; eventType: string } } }) => {
          const { transactionHash, eventType } = args.where.transactionHash_eventType;
          const row = events.get(rowKey(transactionHash, eventType));
          return row ? { id: row.id } : null;
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
    tx,
    // Mirrors `prisma.$transaction`, including rollback, so a throw inside the
    // handler cannot leave a half-applied stream state behind.
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
        tokenAddress: 'CACTTKDP3Y6FMIWSJCMZOPRHGB3KGLFPSHKJZ4AQB6M33EOJCSRGEDR6',
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

const sentinelRecordWithdrawal = vi.hoisted(() => vi.fn());

vi.mock('../src/services/sentinel.service.js', () => ({
  sentinelService: {
    recordWithdrawal: sentinelRecordWithdrawal,
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

// ─── ScVal fixtures ──────────────────────────────────────────────────────────
const sym = (name: string) => ({ sym: { toString: () => name } });
const u64 = (value: number | bigint | string) => ({ u64: { toString: () => String(value) } });
const i128 = (hi: number | bigint | string, lo: number | bigint | string) => ({
  i128: { hi: { toString: () => String(hi) }, lo: { toString: () => String(lo) } },
});
const recipientBytes = Buffer.alloc(32, 11);
const accountScVal = (bytes: Buffer) => ({
  address: { type: 'scAddressTypeAccount', accountId: { ed25519: { value: bytes } } },
});
const entry = (key: string, val: unknown) => ({ key: sym(key), val });
const mapOf = (entries: unknown[]) => ({ map: entries });

const RECIPIENT = StrKey.encodeEd25519PublicKey(recipientBytes);

interface EventOverrides {
  streamId?: number;
  txHash?: string;
  ledger?: number;
  ledgerClosedAt?: string;
}

/** `stream_completed` payload as the contract emits it (`StreamCompletedEvent`). */
function completionEvent(
  overrides: EventOverrides & { totalWithdrawn?: [number | bigint, number | bigint]; includeRecipient?: boolean },
) {
  const entries: unknown[] = [];
  if (overrides.includeRecipient !== false) entries.push(entry('recipient', accountScVal(recipientBytes)));
  if (overrides.totalWithdrawn) entries.push(entry('total_withdrawn', i128(overrides.totalWithdrawn[0], overrides.totalWithdrawn[1])));

  return {
    id: `${overrides.txHash ?? 'tx-complete'}-0`,
    type: 'contract',
    ledger: overrides.ledger ?? 2000,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '1700001000',
    txHash: overrides.txHash ?? 'tx-complete',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [sym('stream_completed'), u64(overrides.streamId ?? 7)],
    value: mapOf(entries),
  } as unknown as rpc.Api.EventResponse;
}

/** `tokens_withdrawn` payload — the incrementing sibling handler. */
function withdrawalEvent(overrides: EventOverrides & { amount?: [number | bigint, number | bigint]; at?: number }) {
  return {
    id: `${overrides.txHash ?? 'tx-withdraw'}-0`,
    type: 'contract',
    ledger: overrides.ledger ?? 1999,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '1700000900',
    txHash: overrides.txHash ?? 'tx-withdraw',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [sym('tokens_withdrawn'), u64(overrides.streamId ?? 7)],
    value: mapOf([
      entry('recipient', accountScVal(recipientBytes)),
      entry('amount', i128((overrides.amount ?? [0, 600])[0], (overrides.amount ?? [0, 600])[1])),
      entry('timestamp', u64(overrides.at ?? 1700000900)),
    ]),
  } as unknown as rpc.Api.EventResponse;
}

const completedEvent = completionEvent({ totalWithdrawn: [0, 1000] });

function streamRow(id = 7n) {
  return fake.streams.get(id);
}
function eventRows() {
  return [...fake.events.values()] as unknown as FakeStreamEvent[];
}
function rowsOfType(eventType: string) {
  return eventRows().filter((row) => row.eventType === eventType);
}
function broadcastCalls() {
  return (sseService.broadcastToStream as ReturnType<typeof vi.fn>).mock.calls;
}

describe('SorobanEventWorker — stream_completed ordering and replay (#1763)', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    fake.reset();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2025, 0, 1, 0, 0, 0));
    sentinelRecordWithdrawal.mockResolvedValue(undefined);
    worker = new SorobanEventWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('completion after the final withdrawal', () => {
    it('overwrites withdrawnAmount with the chain-authoritative total instead of adding to it', async () => {
      fake.stream(7n, { withdrawnAmount: '1000' });

      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 1000] }));

      expect(streamRow()).toMatchObject({ isActive: false, withdrawnAmount: '1000' });
      const updateArg = (fake.tx.stream.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data).not.toHaveProperty('depositedAmount');
    });

    it('matches the running total when every withdrawal was indexed first', async () => {
      fake.stream(7n);

      await worker.processEvent(withdrawalEvent({ txHash: '0xw1', amount: [0, 400] }));
      await worker.processEvent(withdrawalEvent({ txHash: '0xw2', amount: [0, 600] }));
      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 1000] }));

      expect(streamRow()?.withdrawnAmount).toBe('1000');
      expect(rowsOfType('WITHDRAWN')).toHaveLength(2);
      expect(rowsOfType('COMPLETED')).toHaveLength(1);
    });

    it('closes the stream even when the on-chain total is below the indexed withdrawals', async () => {
      // Refunds / fee accounting can leave the chain total lower than what the
      // indexer accumulated; the completion is still authoritative.
      fake.stream(7n, { withdrawnAmount: '1200' });

      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 1000] }));

      expect(streamRow()).toMatchObject({ isActive: false, withdrawnAmount: '1000' });
    });

    it('records one COMPLETED row keyed on txHash + eventType with the cumulative amount', async () => {
      fake.stream(7n);

      await worker.processEvent(completionEvent({ txHash: '0xc1', ledger: 2100, totalWithdrawn: [0, 1000] }));

      const [event] = rowsOfType('COMPLETED');
      expect(rowsOfType('COMPLETED')).toHaveLength(1);
      expect(event).toMatchObject({
        streamId: 7n,
        eventType: 'COMPLETED',
        amount: '1000',
        transactionHash: '0xc1',
        ledgerSequence: 2100,
      });
      expect(JSON.parse(event!.metadata)).toEqual({ recipient: RECIPIENT });
    });

    it('broadcasts stream.completed with the decoded recipient and total', async () => {
      fake.stream(7n);

      await worker.processEvent(completionEvent({ txHash: '0xc1', ledger: 2100, totalWithdrawn: [0, 1000] }));

      expect(broadcastCalls()).toEqual([
        [
          '7',
          'stream.completed',
          {
            streamId: 7n,
            recipient: RECIPIENT,
            totalWithdrawn: '1000',
            transactionHash: '0xc1',
            ledger: 2100,
            timestamp: 1700001000,
          },
        ],
      ]);
    });
  });

  describe('completion before the final withdrawal', () => {
    it('lets a later withdrawal increment past the authoritative total', async () => {
      // Ordering is observable: the completion assigns 1000, the withdrawal
      // handler then adds its own amount to whatever is stored.
      fake.stream(7n);

      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 1000] }));
      await worker.processEvent(withdrawalEvent({ txHash: '0xw3', amount: [0, 600] }));

      expect(streamRow()?.withdrawnAmount).toBe('1600');
      expect(Number(streamRow()?.withdrawnAmount)).toBeGreaterThan(Number('1000'));
    });

    it('re-activates nothing: isActive stays false after a trailing withdrawal', async () => {
      fake.stream(7n);

      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 1000] }));
      await worker.processEvent(withdrawalEvent({ txHash: '0xw3', amount: [0, 600] }));

      expect(streamRow()?.isActive).toBe(false);
    });

    it('is idempotent when the trailing withdrawal is itself replayed', async () => {
      fake.stream(7n);

      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 1000] }));
      const withdrawal = withdrawalEvent({ txHash: '0xw3', amount: [0, 600] });
      await worker.processEvent(withdrawal);
      await worker.processEvent(withdrawal);

      expect(streamRow()?.withdrawnAmount).toBe('1600');
      expect(rowsOfType('WITHDRAWN')).toHaveLength(1);
    });
  });

  describe('replay of the same completion event', () => {
    it('does not duplicate the COMPLETED row', async () => {
      fake.stream(7n);

      await worker.processEvent(completedEvent);
      await worker.processEvent(completedEvent);

      expect(rowsOfType('COMPLETED')).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate StreamEvent skipped: txHash=tx-complete type=COMPLETED'),
      );
    });

    it('re-applies the stream update because the guard runs after it', async () => {
      fake.stream(7n, { withdrawnAmount: '0', isActive: true, lastUpdateTime: 1n });

      await worker.processEvent(completedEvent);
      await worker.processEvent(completedEvent);

      expect(fake.tx.stream.update).toHaveBeenCalledTimes(2);
      expect(fake.tx.streamEvent.findUnique).toHaveBeenCalledTimes(2);
      expect(streamRow()).toMatchObject({ isActive: false, withdrawnAmount: '1000' });
    });

    it('re-broadcasts stream.completed to SSE for the replayed event', async () => {
      fake.stream(7n);

      await worker.processEvent(completedEvent);
      await worker.processEvent(completedEvent);

      expect(broadcastCalls()).toHaveLength(2);
    });

    it('keeps the ledger timestamp stable across the replay', async () => {
      fake.stream(7n);

      await worker.processEvent(completedEvent);
      const firstStamp = streamRow()?.lastUpdateTime;
      vi.setSystemTime(Date.UTC(2025, 0, 2, 0, 0, 0));
      await worker.processEvent(completedEvent);

      expect(firstStamp).toBe(1700001000);
      expect(streamRow()?.lastUpdateTime).toBe(1700001000);
    });
  });

  describe('failure contract', () => {
    it('rejects when recipient is absent from the event body', async () => {
      fake.stream(7n);

      await expect(
        worker.processEvent(completionEvent({ includeRecipient: false, totalWithdrawn: [0, 1000] })),
      ).rejects.toThrow('StreamCompleted #7: missing body fields');

      expect(fake.tx.stream.update).not.toHaveBeenCalled();
      expect(rowsOfType('COMPLETED')).toHaveLength(0);
      expect(broadcastCalls()).toHaveLength(0);
    });

    it('rejects when total_withdrawn is absent from the event body', async () => {
      fake.stream(7n);

      await expect(worker.processEvent(completionEvent({}))).rejects.toThrow(
        'StreamCompleted #7: missing body fields',
      );

      expect(fake.tx.stream.update).not.toHaveBeenCalled();
    });

    it('rejects before the dedup guard when the Stream row is gone', async () => {
      // The update precedes the lookup, so a completion replayed against a
      // pruned stream surfaces P2025 instead of being skipped as a duplicate.
      await expect(worker.processEvent(completedEvent)).rejects.toMatchObject({ code: 'P2025' });

      expect(fake.tx.streamEvent.findUnique).not.toHaveBeenCalled();
      expect(rowsOfType('COMPLETED')).toHaveLength(0);
      expect(broadcastCalls()).toHaveLength(0);
    });

    it('ignores a completion event that carries no stream id topic', async () => {
      fake.stream(7n);

      await worker.processEvent({
        id: 'truncated',
        ledger: 2001,
        ledgerClosedAt: '1700001100',
        txHash: 'tx-truncated',
        topic: [sym('stream_completed')],
        value: mapOf([entry('recipient', accountScVal(recipientBytes)), entry('total_withdrawn', i128(0, 1))]),
      } as unknown as rpc.Api.EventResponse);

      expect(fake.$transaction).not.toHaveBeenCalled();
      expect(broadcastCalls()).toHaveLength(0);
    });

    it('rolls back the whole transaction when the event-row write fails', async () => {
      fake.stream(7n, { withdrawnAmount: '0', isActive: true });
      (fake.tx.streamEvent.upsert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('deadlock detected'),
      );

      await expect(worker.processEvent(completedEvent)).rejects.toThrow('deadlock detected');

      expect(streamRow()).toMatchObject({ isActive: true, withdrawnAmount: '0' });
      expect(broadcastCalls()).toHaveLength(0);
    });
  });

  describe('boundary inputs', () => {
    it('handles a zero total_withdrawn completion (nothing was ever claimed)', async () => {
      fake.stream(7n, { withdrawnAmount: '0' });

      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 0] }));

      expect(streamRow()).toMatchObject({ isActive: false, withdrawnAmount: '0' });
      expect(rowsOfType('COMPLETED')[0]?.amount).toBe('0');
    });

    it('handles a total that spans both halves of the i128', async () => {
      fake.stream(7n);

      await worker.processEvent(completionEvent({ totalWithdrawn: [1, 5] }));

      const expected = (1n << 64n) | 5n;
      expect(streamRow()?.withdrawnAmount).toBe(expected.toString());
      expect(rowsOfType('COMPLETED')[0]?.amount).toBe(expected.toString());
    });

    it('stamps the ledger close time rather than the processing time', async () => {
      fake.stream(7n);

      await worker.processEvent(completionEvent({ ledgerClosedAt: '1700001000', totalWithdrawn: [0, 1000] }));

      expect(streamRow()?.lastUpdateTime).toBe(1700001000);
      expect(rowsOfType('COMPLETED')[0]?.timestamp).toBe(1700001000);
    });

    it('falls back to the wall clock when ledgerClosedAt is not an epoch number', async () => {
      fake.stream(7n);

      await worker.processEvent(
        completionEvent({ ledgerClosedAt: '2024-01-01T00:00:00.000Z', totalWithdrawn: [0, 1000] }),
      );

      expect(streamRow()?.lastUpdateTime).toBe(1735689600);
      expect(rowsOfType('COMPLETED')[0]?.timestamp).toBe(1735689600);
    });
  });

  describe('dependency failures around the withdrawal leg', () => {
    it('swallows a sentinel analysis failure so the withdrawal is still indexed', async () => {
      fake.stream(7n);
      sentinelRecordWithdrawal.mockRejectedValueOnce(new Error('redis unavailable'));

      await worker.processEvent(withdrawalEvent({ txHash: '0xw1', amount: [0, 400] }));

      expect(streamRow()?.withdrawnAmount).toBe('400');
      expect(rowsOfType('WITHDRAWN')).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Sentinel withdrawal analysis failed for #7:'),
        expect.any(Error),
      );
      await worker.processEvent(completionEvent({ totalWithdrawn: [0, 400] }));
      expect(streamRow()).toMatchObject({ isActive: false, withdrawnAmount: '400' });
    });

    it('does not index a withdrawal whose stream row is missing, so completion cannot stack on it', async () => {
      await expect(worker.processEvent(withdrawalEvent({ txHash: '0xw1', amount: [0, 400] }))).rejects.toMatchObject({
        code: 'P2025',
      });

      expect(rowsOfType('WITHDRAWN')).toHaveLength(0);

      await expect(worker.processEvent(completedEvent)).rejects.toMatchObject({ code: 'P2025' });
      expect(streamRow(7n)).toBeUndefined();
    });
  });
});
