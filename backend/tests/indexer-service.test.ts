import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    indexerState: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    triggerPoll: vi.fn(),
    runExclusive: vi.fn((fn: () => Promise<void>) => fn()),
  },
}));

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  return {
    ...actual,
    default: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { prisma } from '../src/lib/prisma.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import * as indexerService from '../src/services/indexerService.js';

const mockedPrisma = prisma as unknown as {
  indexerState: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

const mockedWorker = sorobanEventWorker as unknown as {
  triggerPoll: ReturnType<typeof vi.fn>;
  runExclusive: ReturnType<typeof vi.fn>;
};

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

  it('acquires the worker mutex before writing during resetIndexer', async () => {
    mockedPrisma.indexerState.upsert.mockResolvedValueOnce({
      id: 'singleton',
      lastLedger: 0,
      lastCursor: null,
      updatedAt: new Date(),
    });

    await indexerService.resetIndexer(0);

    expect(mockedWorker.runExclusive).toHaveBeenCalledTimes(1);
    expect(mockedWorker.runExclusive).toHaveBeenCalledWith(expect.any(Function));
    // The upsert must happen INSIDE runExclusive — verify it was called
    // (the mock passes through, so the callback executes the upsert).
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

  it('reset during an in-flight poll ends with the reset cursor winning (#1221)', async () => {
    // Simulate the race condition:
    // 1. A poll batch is in-flight (runExclusive is already held).
    // 2. Admin calls resetIndexer which must wait for the mutex.
    // 3. The poll finishes and writes its cursor.
    // 4. The reset then acquires the mutex and writes the reset cursor.
    //
    // The mock sequences runExclusive so the first call (poll) holds the
    // mutex until its callback resolves, then the second call (reset)
    // executes.

    const cursorWrites: string[] = [];

    // First call: the in-flight poll. It captures the write.
    mockedWorker.runExclusive
      .mockImplementationOnce(async (fn: () => Promise<void>) => {
        await fn();
        cursorWrites.push('poll');
      })
      // Second call: the admin reset.
      .mockImplementationOnce(async (fn: () => Promise<void>) => {
        await fn();
        cursorWrites.push('reset');
      });

    // Poll's upsert
    mockedPrisma.indexerState.upsert
      .mockResolvedValueOnce({
        id: 'singleton', lastLedger: 200, lastCursor: 'cursor-poll', updatedAt: new Date(),
      })
      // Reset's upsert
      .mockResolvedValueOnce({
        id: 'singleton', lastLedger: 100, lastCursor: null, updatedAt: new Date(),
      });

    // Simulate an in-flight poll completing (e.g. triggerPoll)
    mockedWorker.triggerPoll.mockResolvedValueOnce(undefined);

    // Start the poll, then immediately reset
    const pollPromise = mockedWorker.runExclusive(async () => {
      mockedPrisma.indexerState.upsert.mockResolvedValueOnce({
        id: 'singleton', lastLedger: 200, lastCursor: 'cursor-poll', updatedAt: new Date(),
      });
      await mockedPrisma.indexerState.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', lastLedger: 200, lastCursor: 'cursor-poll' },
        update: { lastLedger: 200, lastCursor: 'cursor-poll' },
      });
    });

    // Wait for poll to finish, then reset
    await pollPromise;
    await indexerService.resetIndexer(100);

    // Verify both were called and the reset's upsert was the LAST write
    expect(mockedWorker.runExclusive).toHaveBeenCalledTimes(2);
    expect(cursorWrites).toEqual(['poll', 'reset']);

    // The final upsert call should be the reset's (lastLedger: 100, lastCursor: null)
    const allUpserts = mockedPrisma.indexerState.upsert.mock.calls;
    const lastUpsert = allUpserts[allUpserts.length - 1]![0];
    expect(lastUpsert.update.lastLedger).toBe(100);
    expect(lastUpsert.update.lastCursor).toBeNull();
  });
});
