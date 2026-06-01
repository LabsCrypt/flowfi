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
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

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
    expect(
      mockedPrisma.indexerState.upsert.mock.invocationCallOrder[0]
    ).toBeLessThan(mockedWorker.triggerPoll.mock.invocationCallOrder[0]);
  });
});
