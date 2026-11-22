/**
 * Pause and resume event accounting (issue #1760).
 *
 * `handleStreamPaused` and `handleStreamResumed` own three separate contracts
 * that the existing worker tests touch only from the outside: the stream-state
 * write (which flags, which numbers), the `StreamEvent` row (whose `metadata`
 * is the only durable record of how long the stream sat paused), and the
 * missing-field guard that runs before any of it. The replay tests already in
 * `soroban-event-worker.test.ts` assert that a duplicate writes no second event
 * row; they never read the arguments of either write, so a duration computed
 * against the wrong operand, a `pausedAt` that is never cleared, or an
 * accumulator that replaces instead of adds all passed there.
 *
 * Everything here is pure-mock: no network, no database, and timestamps come
 * from the event's own `ledgerClosedAt` rather than the wall clock, except in
 * the fallback suite where the clock is fixed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrKey, rpc } from '@stellar/stellar-sdk';

const hoisted = vi.hoisted(() => {
  const tx = {
    stream: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn((cb: (client: unknown) => unknown) => cb(tx)),
    },
  };
});

vi.mock('../src/lib/prisma.js', () => ({
  prisma: hoisted.prisma,
  default: hoisted.prisma,
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from '../src/lib/prisma.js';
import logger from '../src/logger.js';
import { sseService } from '../src/services/sse.service.js';
import {
  SorobanEventWorker,
  getEventLedgerTimestamp,
} from '../src/workers/soroban-event-worker.js';

const tx = hoisted.tx;
const mockedPrisma = prisma as unknown as typeof hoisted.prisma;

// The XDR shapes the worker's decoders read, matching the property-based mocks
// the other worker suites use.
const sym = (name: string) => ({ sym: { toString: () => name } }) as never;
const u64 = (value: number | string) => ({ u64: { toString: () => String(value) } }) as never;
const accountAddress = () =>
  ({
    address: { type: 'scAddressTypeAccount', accountId: { ed25519: { value: Buffer.alloc(32) } } },
  }) as never;

/** The single sender every fixture decodes to, so metadata asserts are exact. */
const SENDER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

interface EventFixture {
  txHash: string;
  ledger: number;
  /** Raw `ledgerClosedAt`, numeric or not, so both timestamp paths are reachable. */
  closedAt: string;
  topicName: string;
  streamId: number;
  body: Array<[string, unknown]>;
}

function buildEvent(fixture: EventFixture): rpc.Api.EventResponse {
  return {
    id: `${fixture.txHash}-${fixture.ledger}`,
    type: 'contract',
    ledger: fixture.ledger,
    ledgerClosedAt: fixture.closedAt,
    txHash: fixture.txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [sym(fixture.topicName), u64(fixture.streamId)],
    value: {
      type: 'scvMap',
      map: fixture.body.map(([key, val]) => ({ key: sym(key), val })),
    },
  } as unknown as rpc.Api.EventResponse;
}

const pausedEvent = (overrides: Partial<EventFixture> = {}) =>
  buildEvent({
    txHash: 'pause-tx',
    ledger: 3000,
    closedAt: '1700001234',
    topicName: 'stream_paused',
    streamId: 10,
    body: [
      ['sender', accountAddress()],
      ['paused_at', u64('1700001000')],
    ],
    ...overrides,
  });

const resumedEvent = (overrides: Partial<EventFixture> = {}) =>
  buildEvent({
    txHash: 'resume-tx',
    ledger: 3001,
    closedAt: '1700001045',
    topicName: 'stream_resumed',
    streamId: 11,
    body: [
      ['sender', accountAddress()],
      ['new_end_time', u64('1700090000')],
    ],
    ...overrides,
  });

/** The `metadata` column of the event row the handler just wrote. */
function metadataOf(callIndex = 0): Record<string, unknown> {
  const arg = tx.streamEvent.upsert.mock.calls[callIndex]![0] as {
    create: { metadata: string };
  };
  return JSON.parse(arg.create.metadata) as Record<string, unknown>;
}

function updateData(callIndex = 0): Record<string, unknown> {
  const arg = tx.stream.update.mock.calls[callIndex]![0] as { data: Record<string, unknown> };
  return arg.data;
}

describe('stream pause accounting (#1760)', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventWorker();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));
    tx.stream.update.mockResolvedValue({});
    tx.stream.findUniqueOrThrow.mockResolvedValue({ pausedAt: null, totalPausedDuration: 0 });
    tx.streamEvent.findUnique.mockResolvedValue(null);
    tx.streamEvent.upsert.mockResolvedValue({ id: 'event-row' });
  });

  it('writes the pause state from the event body and the ledger close time', async () => {
    const event = pausedEvent();

    await (worker as any).handleStreamPaused(event, event.topic![1]);

    // `streamId` is a decoded u64, so it reaches the where clause as a bigint.
    expect(tx.stream.update).toHaveBeenCalledWith({
      where: { streamId: 10n },
      data: { isPaused: true, pausedAt: 1700001000, lastUpdateTime: 1700001234 },
    });
    expect(updateData().pausedAt).toBe(1700001000);
    expect(tx.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          streamId: 10n,
          eventType: 'PAUSED',
          transactionHash: 'pause-tx',
          ledgerSequence: 3000,
          timestamp: 1700001234,
        }),
      }),
    );
    expect(metadataOf()).toEqual({ sender: SENDER, pausedAt: 1700001000 });
    expect(sseService.broadcastToStream).toHaveBeenCalledWith('10', 'stream.paused', {
      streamId: 10n,
      sender: SENDER,
      pausedAt: 1700001000,
      transactionHash: 'pause-tx',
      ledger: 3000,
      timestamp: 1700001234,
    });
  });

  it('rejects a pause event whose body has no paused_at before touching the database', async () => {
    const event = pausedEvent({ body: [['sender', accountAddress()]] });

    await expect((worker as any).handleStreamPaused(event, event.topic![1])).rejects.toThrow(
      'StreamPaused #10: missing body fields',
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(sseService.broadcastToStream).not.toHaveBeenCalled();
  });

  it('rejects a pause event whose body has no sender', async () => {
    const event = pausedEvent({ body: [['paused_at', u64('1700001000')]] });

    await expect((worker as any).handleStreamPaused(event, event.topic![1])).rejects.toThrow(
      'StreamPaused #10: missing body fields',
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('still applies the pause to the stream when the PAUSED event row already exists', async () => {
    // The replay guard suppresses the duplicate event row; it does not undo the
    // state transition, which is what an operator re-running a ledger expects.
    tx.streamEvent.findUnique.mockResolvedValue({ id: 'event-row' });
    const event = pausedEvent();

    await (worker as any).handleStreamPaused(event, event.topic![1]);

    expect(tx.stream.update).toHaveBeenCalledTimes(1);
    expect(tx.streamEvent.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[SorobanWorker] Duplicate StreamEvent skipped: txHash=pause-tx type=PAUSED',
    );
  });
});

describe('stream resume accounting (#1760)', () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventWorker();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));
    tx.stream.update.mockResolvedValue({});
    tx.stream.findUniqueOrThrow.mockResolvedValue({ pausedAt: null, totalPausedDuration: 0 });
    tx.streamEvent.findUnique.mockResolvedValue(null);
    tx.streamEvent.upsert.mockResolvedValue({ id: 'event-row' });
  });

  it('adds the paused span to the stored total and clears pausedAt', async () => {
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: 1700001000,
      totalPausedDuration: 0,
    });
    const event = resumedEvent();

    await (worker as any).handleStreamResumed(event, event.topic![1]);

    // 1700001045 (ledger close) - 1700001000 (pause) = 45 seconds paused.
    expect(tx.stream.update).toHaveBeenCalledWith({
      where: { streamId: 11n },
      data: {
        isPaused: false,
        pausedAt: null,
        endTime: 1700090000n,
        totalPausedDuration: 45,
        lastUpdateTime: 1700001045,
      },
    });
    expect(metadataOf()).toEqual({
      sender: SENDER,
      newEndTime: '1700090000',
      pausedDuration: 45,
      totalPausedDuration: 45,
    });
    // The span is read back with the row the handler selected, not recomputed
    // from the event: only `pausedAt` and the ledger time can produce 45.
    expect(tx.stream.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { streamId: 11n },
      select: { pausedAt: true, totalPausedDuration: true },
    });
  });

  it('converts a BigInt pausedAt so the duration is not a bigint sum', async () => {
    // `Stream.pausedAt` is a BigInt column, so this — not a JS number — is what
    // Prisma hands back in production. Without the Number() cast the stored
    // total becomes a bigint and the Int column write is rejected.
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: 1700001000n,
      totalPausedDuration: 10,
    });
    const event = resumedEvent();

    await (worker as any).handleStreamResumed(event, event.topic![1]);

    expect(updateData()).toEqual({
      isPaused: false,
      pausedAt: null,
      endTime: 1700090000n,
      totalPausedDuration: 55,
      lastUpdateTime: 1700001045,
    });
    expect(typeof metadataOf().totalPausedDuration).toBe('number');
  });

  it('adds zero when the stream was not paused', async () => {
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: null,
      totalPausedDuration: 30,
    });
    const event = resumedEvent();

    await (worker as any).handleStreamResumed(event, event.topic![1]);

    expect(updateData().totalPausedDuration).toBe(30);
    expect(updateData().pausedAt).toBeNull();
    expect(metadataOf()).toEqual({
      sender: SENDER,
      newEndTime: '1700090000',
      pausedDuration: 0,
      totalPausedDuration: 30,
    });
  });

  it('accumulates across cycles instead of replacing the stored total', async () => {
    // First pause/resume pair: 15 seconds.
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: 1700001000,
      totalPausedDuration: 0,
    });
    const first = resumedEvent({
      txHash: 'resume-tx-1',
      ledger: 3001,
      closedAt: '1700001015',
      body: [
        ['sender', accountAddress()],
        ['new_end_time', u64('1700090000')],
      ],
    });
    await (worker as any).handleStreamResumed(first, first.topic![1]);
    expect(updateData(0).totalPausedDuration).toBe(15);

    // Second pair starts from the row the first cycle wrote: 15 stored, 25 more.
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));
    tx.stream.update.mockResolvedValue({});
    tx.streamEvent.findUnique.mockResolvedValue(null);
    tx.streamEvent.upsert.mockResolvedValue({ id: 'event-row' });
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: 1700002000,
      totalPausedDuration: 15,
    });
    const second = resumedEvent({
      txHash: 'resume-tx-2',
      ledger: 3002,
      closedAt: '1700002025',
    });
    await (worker as any).handleStreamResumed(second, second.topic![1]);

    expect(updateData(0).totalPausedDuration).toBe(40);
    expect(metadataOf()).toEqual({
      sender: SENDER,
      newEndTime: '1700090000',
      pausedDuration: 25,
      totalPausedDuration: 40,
    });
  });

  it('rejects a resume event whose body is missing sender or new_end_time', async () => {
    const noSender = resumedEvent({ body: [['new_end_time', u64('1700090000')]] });
    await expect((worker as any).handleStreamResumed(noSender, noSender.topic![1])).rejects.toThrow(
      'StreamResumed #11: missing body fields',
    );

    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    const noEndTime = resumedEvent({ body: [['sender', accountAddress()]] });
    await expect((worker as any).handleStreamResumed(noEndTime, noEndTime.topic![1])).rejects.toThrow(
      'StreamResumed #11: missing body fields',
    );

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(tx.stream.update).not.toHaveBeenCalled();
  });

  it('propagates a failed stream read instead of writing a guessed total', async () => {
    tx.stream.findUniqueOrThrow.mockRejectedValue(new Error('stream missing'));
    const event = resumedEvent();

    await expect((worker as any).handleStreamResumed(event, event.topic![1])).rejects.toThrow(
      'stream missing',
    );
    expect(tx.stream.update).not.toHaveBeenCalled();
    expect(tx.streamEvent.upsert).not.toHaveBeenCalled();
    expect(sseService.broadcastToStream).not.toHaveBeenCalled();
  });

  it('still applies the resume when the RESUMED event row already exists', async () => {
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: 1700001000,
      totalPausedDuration: 0,
    });
    tx.streamEvent.findUnique.mockResolvedValue({ id: 'event-row' });
    const event = resumedEvent();

    await (worker as any).handleStreamResumed(event, event.topic![1]);

    expect(tx.stream.update).toHaveBeenCalledTimes(1);
    expect(updateData().totalPausedDuration).toBe(45);
    expect(tx.streamEvent.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[SorobanWorker] Duplicate StreamEvent skipped: txHash=resume-tx type=RESUMED',
    );
  });

  it('broadcasts the resumed state without the durations, which live in the event metadata', async () => {
    // Issue #1760 asks for the computed durations in the SSE payload. They are
    // not there today: the broadcast carries the state transition and the
    // `pausedDuration`/`totalPausedDuration` pair is persisted only on the
    // RESUMED StreamEvent row. Pinned so the next reader learns the real
    // contract instead of inferring one from the ticket, and so a future change
    // to either surface has to say so here.
    tx.stream.findUniqueOrThrow.mockResolvedValue({
      pausedAt: 1700001000,
      totalPausedDuration: 0,
    });
    const event = resumedEvent();

    await (worker as any).handleStreamResumed(event, event.topic![1]);

    expect(sseService.broadcastToStream).toHaveBeenCalledWith('11', 'stream.resumed', {
      streamId: 11n,
      sender: SENDER,
      newEndTime: '1700090000',
      transactionHash: 'resume-tx',
      ledger: 3001,
      timestamp: 1700001045,
    });
    expect(metadataOf().totalPausedDuration).toBe(45);
  });
});

describe('getEventLedgerTimestamp (#1760)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a numeric ledgerClosedAt verbatim, so history is not stamped with now', () => {
    expect(getEventLedgerTimestamp({ ledgerClosedAt: '1735689599' })).toBe(1735689599);
    expect(getEventLedgerTimestamp({ ledgerClosedAt: '0' })).toBe(0);
  });

  it('falls back to the wall clock for an ISO close time', () => {
    // The Horizon shape the SDK documents is ISO-8601, and every integration
    // fixture in this repo feeds exactly that through this branch.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'));

    expect(getEventLedgerTimestamp({ ledgerClosedAt: '2023-01-01T00:00:00Z' })).toBe(
      Math.floor(Date.parse('2024-06-01T12:00:00Z') / 1000),
    );
  });

  it('falls back for a negative, fractional or non-numeric close time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'));
    const nowSeconds = Math.floor(Date.parse('2024-06-01T12:00:00Z') / 1000);

    for (const raw of ['-5', '1.5', 'not-a-ledger', 'NaN', 'Infinity']) {
      expect(getEventLedgerTimestamp({ ledgerClosedAt: raw }), raw).toBe(nowSeconds);
    }
  });

  it('treats an empty close time as ledger zero, not as unusable', () => {
    // `Number('')` is 0 and 0 passes the guard, so an absent close time becomes
    // the epoch rather than falling back. Recorded because it is the one input
    // a reader would expect to take the fallback path and does not.
    expect(getEventLedgerTimestamp({ ledgerClosedAt: '' })).toBe(0);
  });

  it('falls back rather than returning an unsafe integer that would drift', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00Z'));

    // 2^53 parses to a Number but is no longer exact, so the guard treats it as
    // unusable instead of storing a rounded timestamp.
    expect(getEventLedgerTimestamp({ ledgerClosedAt: '9007199254740992' })).toBe(
      Math.floor(Date.parse('2024-06-01T12:00:00Z') / 1000),
    );
  });
});
