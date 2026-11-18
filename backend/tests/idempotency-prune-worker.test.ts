import { describe, it, expect, vi, beforeEach } from 'vitest';
import logger from '../src/logger.js';
import {
  IDEMPOTENCY_KEY_RETENTION_MS,
  idempotencyRetentionCutoff,
  isExpiredIdempotencyKey,
  pruneExpiredIdempotencyKeys,
  startIdempotencyPruneWorker,
} from '../src/workers/idempotency-prune-worker.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// In-memory stand-in for the IdempotencyKey table. `deleteMany` honours the
// `createdAt < cutoff` filter exactly like Postgres so the tests can prove
// which rows survive a sweep.
const { store, deleteMany } = vi.hoisted(() => {
  const rows: { id: string; createdAt: Date }[] = [];
  const deleteManyMock = vi.fn(
    async (args: { where: { createdAt: { lt: Date } } }) => {
      const cutoff = args.where.createdAt.lt.getTime();
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        if (row.createdAt.getTime() < cutoff) {
          rows.splice(i, 1);
          count++;
        }
      }
      return { count };
    },
  );
  return { store: rows, deleteMany: deleteManyMock };
});

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    idempotencyKey: { deleteMany },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Idempotency prune worker (#1495)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.length = 0;
  });

  it('keeps the retention window at seven days', () => {
    expect(IDEMPOTENCY_KEY_RETENTION_MS).toBe(7 * DAY_MS);
  });

  it('deletes only records older than the retention window', async () => {
    const now = Date.now();
    store.push(
      { id: 'stale', createdAt: new Date(now - 8 * DAY_MS) },
      { id: 'just-expired', createdAt: new Date(now - 7 * DAY_MS - 1000) },
      { id: 'fresh', createdAt: new Date(now - 1 * DAY_MS) },
      { id: 'just-inside', createdAt: new Date(now - 7 * DAY_MS + 60_000) },
    );

    const pruned = await pruneExpiredIdempotencyKeys(now);

    expect(pruned).toBe(2);
    expect(store.map((row) => row.id).sort()).toEqual(['fresh', 'just-inside']);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: idempotencyRetentionCutoff(now) } },
    });
  });

  it('preserves records inside the retention window', async () => {
    const now = Date.now();
    store.push(
      { id: 'within-window', createdAt: new Date(now - 6 * DAY_MS) },
      { id: 'brand-new', createdAt: new Date(now) },
    );

    const pruned = await pruneExpiredIdempotencyKeys(now);

    expect(pruned).toBe(0);
    expect(store.map((row) => row.id).sort()).toEqual(['brand-new', 'within-window']);
  });

  it('logs the number of pruned records', async () => {
    const now = Date.now();
    store.push({ id: 'ancient', createdAt: new Date(now - 30 * DAY_MS) });

    await pruneExpiredIdempotencyKeys(now);

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Pruned 1'));
  });

  it('matches the delete boundary in isExpiredIdempotencyKey', () => {
    const now = Date.now();
    expect(isExpiredIdempotencyKey(new Date(now - 8 * DAY_MS), now)).toBe(true);
    expect(isExpiredIdempotencyKey(new Date(now - 6 * DAY_MS), now)).toBe(false);
  });

  it('runs an immediate sweep and schedules a repeating timer', async () => {
    const now = Date.now();
    store.push({ id: 'old', createdAt: new Date(now - 10 * DAY_MS) });

    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(999 as unknown as NodeJS.Timeout);

    const timer = startIdempotencyPruneWorker(60_000);
    await Promise.resolve();

    expect(timer).toBe(999);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(store).toHaveLength(0);

    clearInterval(timer);
    setIntervalSpy.mockRestore();
  });
});
