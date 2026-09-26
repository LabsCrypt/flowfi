import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Contract, rpc, xdr } from '@stellar/stellar-sdk';

const hoisted = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  triggerPoll: vi.fn(),
  processEvent: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    indexerState: {
      findUnique: hoisted.findUnique,
      upsert: hoisted.upsert,
    },
    indexerDeadLetterEvent: {
      findUnique: hoisted.findUnique,
      findMany: hoisted.findMany,
      count: hoisted.count,
      update: hoisted.update,
      delete: hoisted.delete,
      upsert: hoisted.upsert,
    },
  },
}));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    triggerPoll: hoisted.triggerPoll,
    processEvent: hoisted.processEvent,
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Metrics and tracing are side-effect-only here; stub them so the assertions
// below are not perturbed by the shared Prometheus registry.
vi.mock('../src/lib/metrics.js', () => ({
  setIndexerLedgers: vi.fn(),
  indexerEventsProcessedTotal: { inc: vi.fn() },
  indexerPollsTotal: { inc: vi.fn() },
  recordRpcRequest: vi.fn(),
  rpcCircuitBreakerTripsTotal: { inc: vi.fn() },
  rpcFailoversTotal: { inc: vi.fn() },
  rpcRequestDuration: { observe: vi.fn() },
  rpcRequestsTotal: { inc: vi.fn() },
  sseClientsDroppedTotal: { inc: vi.fn() },
  sseConnectionsTotal: { inc: vi.fn() },
  sseMaxConnections: { set: vi.fn() },
  setSseConnectionCounts: vi.fn(),
  dbPoolConnections: { set: vi.fn() },
  dbPoolMaxConnections: { set: vi.fn() },
  dbQueryDuration: { observe: vi.fn() },
  httpRequestsTotal: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
}));

vi.mock('../src/lib/tracing.js', () => ({
  withSpan: (_name: string, _attrs: unknown, fn: (span: unknown) => unknown) => fn({}),
}));

import { prisma } from '../src/lib/prisma.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import * as indexerService from '../src/services/indexerService.js';

const mockedPrisma = prisma as unknown as {
  indexerState: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  indexerDeadLetterEvent: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

const mockedWorker = sorobanEventWorker as unknown as {
  triggerPoll: ReturnType<typeof vi.fn>;
  processEvent: ReturnType<typeof vi.fn>;
};

/** Build a minimal but structurally valid Soroban EventResponse. */
function makeEvent(overrides: Partial<rpc.Api.EventResponse> = {}): rpc.Api.EventResponse {
  return {
    id: 'event-0001',
    type: 'contract',
    ledger: 482910,
    ledgerClosedAt: '2026-09-26T00:00:00Z',
    txHash: 'abc123',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [xdr.ScVal.scvSymbol('stream_created'), nativeToU64(7)],
    value: xdr.ScVal.scvMap([]),
    ...overrides,
  } as unknown as rpc.Api.EventResponse;
}

function nativeToU64(value: number): xdr.ScVal {
  // scvU64 expects a Uint64, which is not constructible from a JS number.
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(value)));
}

describe('Indexer Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns lagSeconds = -1 when no state row exists', async () => {
    mockedPrisma.indexerState.findUnique.mockResolvedValueOnce(null);

    const status = await indexerService.getIndexerStatus();

    expect(status.lagSeconds).toBe(-1);
    expect(status.lastLedger).toBe(0);
    expect(status.lastCursor).toBeNull();
    expect(mockedPrisma.indexerState.findUnique).toHaveBeenCalledWith({
      where: { id: 'singleton' },
    });
  });

  it('returns lagSeconds >= 0 when a state row exists', async () => {
    const updatedAt = new Date(Date.now() - 5_000);
    mockedPrisma.indexerState.findUnique.mockResolvedValueOnce({
      id: 'singleton',
      lastLedger: 123,
      lastCursor: 'cursor-xyz',
      updatedAt,
    });

    const status = await indexerService.getIndexerStatus();

    expect(status.lastLedger).toBe(123);
    expect(status.lastCursor).toBe('cursor-xyz');
    expect(status.updatedAt).toEqual(updatedAt);
    expect(status.lagSeconds).toBeGreaterThanOrEqual(5);
  });

  it('upserts the indexer state with lastCursor null when resetIndexer is called', async () => {
    mockedPrisma.indexerState.upsert.mockResolvedValueOnce({
      id: 'singleton',
      lastLedger: 0,
      lastCursor: null,
      updatedAt: new Date(),
    });

    await indexerService.resetIndexer(0);

    expect(mockedPrisma.indexerState.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastLedger: 0, lastCursor: null },
      update: { lastLedger: 0, lastCursor: null },
    });
  });

  it('calls resetIndexer then triggerPoll when replayFromLedger is invoked', async () => {
    mockedPrisma.indexerState.upsert.mockResolvedValueOnce({
      id: 'singleton',
      lastLedger: 55,
      lastCursor: null,
      updatedAt: new Date(),
    });
    mockedWorker.triggerPoll.mockResolvedValueOnce(undefined);

    await indexerService.replayFromLedger(55);

    expect(mockedPrisma.indexerState.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', lastLedger: 55, lastCursor: null },
      update: { lastLedger: 55, lastCursor: null },
    });
    expect(mockedWorker.triggerPoll).toHaveBeenCalled();
    const upsertOrder = mockedPrisma.indexerState.upsert.mock.invocationCallOrder?.[0] ?? -1;
    const triggerOrder = mockedWorker.triggerPoll.mock.invocationCallOrder?.[0] ?? -1;
    expect(upsertOrder).toBeLessThan(triggerOrder);
  });
});

describe('Dead-letter payload serialisation', () => {
  it('round-trips topic and value ScVals through the stored payload', () => {
    const event = makeEvent();
    const restored = indexerService.deserializeDeadLetterPayload(
      indexerService.serializeDeadLetterPayload(event),
    );

    expect(restored.id).toBe(event.id);
    expect(restored.ledger).toBe(event.ledger);
    expect(restored.transactionIndex).toBe(event.transactionIndex);
    expect(restored.operationIndex).toBe(event.operationIndex);
    expect(restored.inSuccessfulContractCall).toBe(true);
    expect(restored.topic[0]!.sym().toString()).toBe('stream_created');
    expect(restored.topic[1]!.u64().toString()).toBe('7');
    expect(restored.value.toXDR()).toEqual(event.value.toXDR());
  });

  it('preserves contractId so handlers can filter by stream contract', () => {
    const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const event = makeEvent({ contractId: new Contract(contractId) });
    const restored = indexerService.deserializeDeadLetterPayload(
      indexerService.serializeDeadLetterPayload(event),
    );

    // Rehydrated as a Contract instance, not the raw string.
    expect(restored.contractId).toBeInstanceOf(Contract);
    expect(String(restored.contractId)).toBe(contractId);
  });

  it('throws when the stored payload is not valid JSON', () => {
    expect(() => indexerService.deserializeDeadLetterPayload('not-json')).toThrow();
  });
});

describe('quarantineEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the event, its error and the decoded event type', async () => {
    mockedPrisma.indexerDeadLetterEvent.upsert.mockResolvedValueOnce({});

    await indexerService.quarantineEvent(
      makeEvent(),
      new Error('StreamCreated #7: missing body fields'),
      'cursor-abc',
    );

    const call = mockedPrisma.indexerDeadLetterEvent.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({
      eventId_eventType: { eventId: 'event-0001', eventType: 'stream_created' },
    });
    expect(call.create).toMatchObject({
      eventId: 'event-0001',
      eventType: 'stream_created',
      txHash: 'abc123',
      ledgerSequence: 482910,
      cursor: 'cursor-abc',
      errorMessage: 'StreamCreated #7: missing body fields',
      attempts: 1,
    });
    expect(typeof call.create.payload).toBe('string');
  });

  it('increments attempts instead of duplicating on a re-quarantine', async () => {
    mockedPrisma.indexerDeadLetterEvent.upsert.mockResolvedValueOnce({});

    await indexerService.quarantineEvent(makeEvent(), new Error('boom'));

    const call = mockedPrisma.indexerDeadLetterEvent.upsert.mock.calls[0]![0];
    expect(call.update.attempts).toEqual({ increment: 1 });
    expect(call.update.errorMessage).toBe('boom');
  });

  it('swallows DB failures so the poll loop is never killed by bookkeeping', async () => {
    mockedPrisma.indexerDeadLetterEvent.upsert.mockRejectedValueOnce(
      new Error('deadlock detected'),
    );

    await expect(
      indexerService.quarantineEvent(makeEvent(), new Error('original failure')),
    ).resolves.toBeUndefined();
  });
});

describe('listDeadLetterEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('paginates, orders newest-first and reports hasMore', async () => {
    mockedPrisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([
      {
        id: 'row-1',
        eventId: 'event-0001',
        eventType: 'stream_created',
        txHash: 'abc123',
        ledgerSequence: 482910,
        errorMessage: 'boom',
        attempts: 2,
        lastAttemptAt: new Date(),
        createdAt: new Date(),
        payload: '{}',
        cursor: null,
      },
    ]);
    mockedPrisma.indexerDeadLetterEvent.count.mockResolvedValueOnce(60);

    const result = await indexerService.listDeadLetterEvents({ page: 2, limit: 25 });

    expect(mockedPrisma.indexerDeadLetterEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25 }),
    );
    expect(result.total).toBe(60);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(25);
    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'row-1', attempts: 2 });
  });

  it('clamps limit to the documented maximum', async () => {
    mockedPrisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([]);
    mockedPrisma.indexerDeadLetterEvent.count.mockResolvedValueOnce(0);

    const result = await indexerService.listDeadLetterEvents({ page: 1, limit: 10_000 });

    expect(result.limit).toBe(indexerService.MAX_DEAD_LETTER_PAGE_SIZE);
    expect(result.hasMore).toBe(false);
  });

  it('applies ledger, date and eventType filters', async () => {
    mockedPrisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([]);
    mockedPrisma.indexerDeadLetterEvent.count.mockResolvedValueOnce(0);

    const startDate = new Date('2026-09-01T00:00:00Z');
    const endDate = new Date('2026-09-26T00:00:00Z');

    await indexerService.listDeadLetterEvents({
      page: 1,
      limit: 10,
      ledgerSequence: 482910,
      startDate,
      endDate,
      eventType: 'stream_topped_up',
    });

    const where = mockedPrisma.indexerDeadLetterEvent.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      ledgerSequence: 482910,
      eventType: 'stream_topped_up',
      createdAt: { gte: startDate, lte: endDate },
    });
  });
});

describe('replayDeadLetterEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const record = (overrides: Record<string, unknown> = {}) => ({
    id: 'row-1',
    eventId: 'event-0001',
    eventType: 'stream_created',
    txHash: 'abc123',
    ledgerSequence: 482910,
    payload: indexerService.serializeDeadLetterPayload(makeEvent()),
    attempts: 1,
    ...overrides,
  });

  it('replays through the worker and deletes the record on success', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(record());
    mockedPrisma.indexerDeadLetterEvent.delete.mockResolvedValueOnce({});

    const result = await indexerService.replayDeadLetterEvent('row-1');

    expect(result).toEqual({ id: 'row-1', outcome: 'replayed', attempts: 1 });
    expect(mockedWorker.processEvent).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.indexerDeadLetterEvent.delete).toHaveBeenCalledWith({
      where: { id: 'row-1' },
    });
    expect(mockedPrisma.indexerDeadLetterEvent.update).not.toHaveBeenCalled();
  });

  it('re-injects the decoded payload, not the stored JSON string', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(record());
    mockedPrisma.indexerDeadLetterEvent.delete.mockResolvedValueOnce({});

    await indexerService.replayDeadLetterEvent('row-1');

    const replayed = mockedWorker.processEvent.mock.calls[0]![0];
    expect(replayed.id).toBe('event-0001');
    expect(replayed.ledger).toBe(482910);
    expect(replayed.topic[0].sym().toString()).toBe('stream_created');
  });

  it('increments attempts and refreshes the error when the replay throws', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(
      record({ attempts: 3 }),
    );
    mockedWorker.processEvent.mockRejectedValueOnce(new Error('still broken'));
    mockedPrisma.indexerDeadLetterEvent.update.mockResolvedValueOnce({ attempts: 4 });

    const result = await indexerService.replayDeadLetterEvent('row-1');

    expect(result).toEqual({
      id: 'row-1',
      outcome: 'failed',
      attempts: 4,
      errorMessage: 'still broken',
    });
    expect(mockedPrisma.indexerDeadLetterEvent.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ attempts: { increment: 1 } }),
    });
    // The row must survive a failed replay.
    expect(mockedPrisma.indexerDeadLetterEvent.delete).not.toHaveBeenCalled();
  });

  it('reports not_found for an unknown id without touching the worker', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(null);

    const result = await indexerService.replayDeadLetterEvent('missing');

    expect(result).toEqual({ id: 'missing', outcome: 'not_found', attempts: 0 });
    expect(mockedWorker.processEvent).not.toHaveBeenCalled();
  });

  it('flags an undecodable payload instead of throwing', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(
      record({ payload: '{ this is not valid json' }),
    );
    mockedPrisma.indexerDeadLetterEvent.update.mockResolvedValueOnce({ attempts: 2 });

    const result = await indexerService.replayDeadLetterEvent('row-1');

    expect(result.outcome).toBe('undecodable');
    expect(result.attempts).toBe(2);
    expect(result.errorMessage).toMatch(/Undecodable dead-letter payload/);
    expect(mockedWorker.processEvent).not.toHaveBeenCalled();
  });
});

describe('replayAllDeadLetterEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replays every pending record in ledger order and summarises outcomes', async () => {
    mockedPrisma.indexerDeadLetterEvent.findMany.mockResolvedValueOnce([
      { id: 'row-1' },
      { id: 'row-2' },
      { id: 'row-3' },
    ]);

    const rows: Record<string, unknown> = {
      'row-1': {
        id: 'row-1',
        eventId: 'e1',
        eventType: 'stream_created',
        ledgerSequence: 1,
        payload: indexerService.serializeDeadLetterPayload(makeEvent({ id: 'e1' })),
        attempts: 1,
      },
      'row-2': {
        id: 'row-2',
        eventId: 'e2',
        eventType: 'tokens_withdrawn',
        ledgerSequence: 2,
        payload: indexerService.serializeDeadLetterPayload(makeEvent({ id: 'e2' })),
        attempts: 1,
      },
      'row-3': {
        id: 'row-3',
        eventId: 'e3',
        eventType: 'fee_collected',
        ledgerSequence: 3,
        payload: indexerService.serializeDeadLetterPayload(makeEvent({ id: 'e3' })),
        attempts: 1,
      },
    };

    mockedPrisma.indexerDeadLetterEvent.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
    );
    mockedPrisma.indexerDeadLetterEvent.delete.mockResolvedValue({});
    mockedPrisma.indexerDeadLetterEvent.update.mockResolvedValue({ attempts: 2 });
    // The middle event keeps failing.
    mockedWorker.processEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(undefined);

    const summary = await indexerService.replayAllDeadLetterEvents();

    expect(summary.attempted).toBe(3);
    expect(summary.replayed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results.map((r) => r.outcome)).toEqual([
      'replayed',
      'failed',
      'replayed',
    ]);
    // Oldest ledger first — sequential, so Stream mutations apply in order.
    expect(mockedPrisma.indexerDeadLetterEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ ledgerSequence: 'asc' }, { createdAt: 'asc' }] }),
    );
    expect(mockedWorker.processEvent).toHaveBeenCalledTimes(3);
  });
});

describe('discardDeadLetterEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the record and reports what was discarded', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce({
      id: 'row-1',
      eventType: 'stream_created',
      txHash: 'abc123',
      ledgerSequence: 482910,
      attempts: 4,
    });
    mockedPrisma.indexerDeadLetterEvent.delete.mockResolvedValueOnce({});

    const discarded = await indexerService.discardDeadLetterEvent('row-1', 'GADMIN');

    expect(discarded).toEqual({
      id: 'row-1',
      eventType: 'stream_created',
      txHash: 'abc123',
      ledgerSequence: 482910,
    });
    expect(mockedPrisma.indexerDeadLetterEvent.delete).toHaveBeenCalledWith({
      where: { id: 'row-1' },
    });
  });

  it('throws DeadLetterNotFoundError for an unknown id', async () => {
    mockedPrisma.indexerDeadLetterEvent.findUnique.mockResolvedValueOnce(null);

    await expect(
      indexerService.discardDeadLetterEvent('missing', 'GADMIN'),
    ).rejects.toBeInstanceOf(indexerService.DeadLetterNotFoundError);
    expect(mockedPrisma.indexerDeadLetterEvent.delete).not.toHaveBeenCalled();
  });
});
