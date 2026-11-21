import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../src/generated/prisma/index.js';
import {
  findStreams,
  markCancelledProvisionally,
} from '../src/repositories/stream.repository.js';

/**
 * Contract tests for the two write paths of `stream.repository.ts` (#1752).
 *
 * `tests/stream.repository.test.ts` already pins *which* Prisma call each
 * function makes. What is pinned here is who performs it, what happens when the
 * dependency answers badly, and the pagination invariant that the count and the
 * page must come from one snapshot — the parts a caller can only discover by
 * being broken in production.
 */

interface FakeClient {
  stream: {
    update: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  streamEvent: { upsert: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

function makeClient(): FakeClient {
  return {
    stream: { update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    streamEvent: { upsert: vi.fn() },
    $transaction: vi.fn(),
  };
}

const mocks = vi.hoisted(() => {
  const make = () => ({
    stream: { update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    streamEvent: { upsert: vi.fn() },
    $transaction: vi.fn(),
  });
  return { primary: make(), replica: make(), withReplicaFallback: vi.fn() };
});

vi.mock('../src/lib/prisma.js', () => ({
  prisma: mocks.primary,
  withReplicaFallback: mocks.withReplicaFallback,
  default: mocks.primary,
}));

const asTx = (client: FakeClient) => client as unknown as Prisma.TransactionClient;

function prismaKnown(code: string, message: string): Error {
  const err = new Error(message);
  err.name = 'PrismaClientKnownRequestError';
  Object.assign(err, { code });
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, but test-local mockImplementation()
  // calls would otherwise leak into the next test, so restate the defaults.
  mocks.primary.$transaction.mockImplementation((fn: (tx: FakeClient) => unknown) =>
    Promise.resolve(fn(mocks.primary)),
  );
  mocks.withReplicaFallback.mockImplementation((query: (client: FakeClient) => unknown) =>
    Promise.resolve(query(mocks.replica)),
  );
  mocks.primary.stream.update.mockResolvedValue({});
  mocks.primary.streamEvent.upsert.mockResolvedValue({});
  mocks.replica.stream.update.mockResolvedValue({});
  mocks.replica.streamEvent.upsert.mockResolvedValue({});
});

describe('markCancelledProvisionally — client selection', () => {
  it('writes through a caller-supplied transaction client without opening its own transaction', async () => {
    const outer = makeClient();
    outer.stream.update.mockResolvedValue({});
    outer.streamEvent.upsert.mockResolvedValue({});

    await markCancelledProvisionally(7n, 'hash-1', asTx(outer));

    expect(outer.stream.update).toHaveBeenCalledWith({
      where: { streamId: 7n },
      data: { isActive: false },
    });
    expect(outer.streamEvent.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.primary.$transaction).not.toHaveBeenCalled();
    expect(mocks.primary.stream.update).not.toHaveBeenCalled();
    expect(mocks.primary.streamEvent.upsert).not.toHaveBeenCalled();
  });

  it('runs both writes on whatever client the transaction driver hands it', async () => {
    await markCancelledProvisionally(7n, 'hash-1');

    const run = mocks.primary.$transaction.mock.calls[0]![0] as (
      tx: FakeClient,
    ) => Promise<void>;
    expect(typeof run).toBe('function');

    vi.clearAllMocks();
    const driven = makeClient();
    driven.stream.update.mockResolvedValue({});
    driven.streamEvent.upsert.mockResolvedValue({});
    await run(driven);

    expect(driven.stream.update).toHaveBeenCalledTimes(1);
    expect(driven.streamEvent.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.primary.stream.update).not.toHaveBeenCalled();
    expect(mocks.primary.streamEvent.upsert).not.toHaveBeenCalled();
  });
});

describe('markCancelledProvisionally — provisional event payload', () => {
  it('leaves an already-written provisional event untouched so the first record wins', async () => {
    await markCancelledProvisionally(7n, 'hash-1');

    const arg = mocks.primary.streamEvent.upsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
    };
    expect(arg.update).toEqual({});
  });

  it('writes the documented placeholder ledger, null amount and api-cancel source', async () => {
    const before = Math.floor(Date.now() / 1000);
    await markCancelledProvisionally(7n, 'hash-1');
    const after = Math.floor(Date.now() / 1000);

    const create = (
      mocks.primary.streamEvent.upsert.mock.calls[0]![0] as {
        create: {
          streamId: bigint;
          eventType: string;
          amount: unknown;
          transactionHash: string;
          ledgerSequence: number;
          timestamp: number;
          metadata: string;
        };
      }
    ).create;

    expect(create.streamId).toBe(7n);
    expect(create.eventType).toBe('CANCELLED');
    expect(create.amount).toBeNull();
    expect(create.transactionHash).toBe('hash-1');
    expect(create.ledgerSequence).toBe(0);
    expect(JSON.parse(create.metadata)).toEqual({
      provisional: true,
      source: 'api-cancel',
    });
    expect(create.timestamp).toBeGreaterThanOrEqual(before);
    expect(create.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('markCancelledProvisionally — dependency failures', () => {
  it('aborts before writing any event when the stream row does not exist', async () => {
    const missing = prismaKnown('P2025', 'Record not found');
    mocks.primary.stream.update.mockRejectedValue(missing);

    await expect(markCancelledProvisionally(7n, 'hash-1')).rejects.toBe(missing);
    expect(mocks.primary.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.primary.streamEvent.upsert).not.toHaveBeenCalled();
  });

  it('propagates an event-write rejection unchanged', async () => {
    const conflict = prismaKnown('P2002', 'Unique constraint failed');
    mocks.primary.streamEvent.upsert.mockRejectedValue(conflict);

    await expect(markCancelledProvisionally(7n, 'hash-1')).rejects.toBe(conflict);
  });

  it('propagates a non-Error rejection instead of masking it', async () => {
    mocks.primary.stream.update.mockRejectedValue('driver exploded');

    await expect(markCancelledProvisionally(7n, 'hash-1')).rejects.toBe('driver exploded');
    expect(mocks.primary.streamEvent.upsert).not.toHaveBeenCalled();
  });

  it('surfaces a transaction-driver failure without attempting a detached write', async () => {
    const dead = prismaKnown('P1001', "Can't reach database server");
    mocks.primary.$transaction.mockRejectedValue(dead);

    await expect(markCancelledProvisionally(7n, 'hash-1')).rejects.toBe(dead);
    expect(mocks.primary.stream.update).not.toHaveBeenCalled();
    expect(mocks.primary.streamEvent.upsert).not.toHaveBeenCalled();
  });
});

describe('findStreams — read snapshot and filters', () => {
  it('reads the page and the total from the same client with the same filter', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([{ streamId: 1n }]);
    mocks.replica.stream.count.mockResolvedValue(1);

    await findStreams({ limit: 1, offset: 0, status: 'active', sender: 'GSENDER' });

    expect(mocks.replica.stream.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.replica.stream.count).toHaveBeenCalledTimes(1);
    expect(mocks.primary.stream.findMany).not.toHaveBeenCalled();
    expect(mocks.primary.stream.count).not.toHaveBeenCalled();

    const page = mocks.replica.stream.findMany.mock.calls[0]![0] as { where: unknown };
    const total = mocks.replica.stream.count.mock.calls[0]![0] as { where: unknown };
    expect(total.where).toEqual(page.where);
  });

  it('filters by recipient and token address without adding unrelated predicates', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([]);
    mocks.replica.stream.count.mockResolvedValue(0);

    await findStreams({
      limit: 10,
      offset: 0,
      recipient: 'GRECIPIENT',
      tokenAddress: 'CTOKEN',
    });

    const arg = mocks.replica.stream.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ recipient: 'GRECIPIENT', tokenAddress: 'CTOKEN' });
  });

  it('honours an explicit sort field and order over the startTime/desc default', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([]);
    mocks.replica.stream.count.mockResolvedValue(0);

    await findStreams({ limit: 10, offset: 0, sortField: 'createdAt', sortOrder: 'asc' });

    const arg = mocks.replica.stream.findMany.mock.calls[0]![0] as {
      orderBy: Record<string, string>;
    };
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('reports no more pages when the window ends exactly on the total', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([{}, {}, {}]);
    mocks.replica.stream.count.mockResolvedValue(3);

    const exact = await findStreams({ limit: 3, offset: 0 });
    expect(exact.hasMore).toBe(false);

    vi.clearAllMocks();
    mocks.withReplicaFallback.mockImplementation((query: (client: FakeClient) => unknown) =>
      Promise.resolve(query(mocks.replica)),
    );
    mocks.replica.stream.findMany.mockResolvedValue([{}, {}, {}]);
    mocks.replica.stream.count.mockResolvedValue(4);

    const short = await findStreams({ limit: 3, offset: 0 });
    expect(short.hasMore).toBe(true);
  });

  it('treats a zero limit as an empty window that still reports the remaining total', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([]);
    mocks.replica.stream.count.mockResolvedValue(5);

    const result = await findStreams({ limit: 0, offset: 0 });

    const arg = mocks.replica.stream.findMany.mock.calls[0]![0] as { take: number };
    expect(arg.take).toBe(0);
    expect(result.streams).toHaveLength(0);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(true);
  });

  it('reports no more pages once the offset is past the total', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([]);
    mocks.replica.stream.count.mockResolvedValue(2);

    const result = await findStreams({ limit: 10, offset: 5 });
    expect(result.hasMore).toBe(false);
  });

  it('rejects when the replica read fails rather than returning an empty page', async () => {
    const down = prismaKnown('P1001', "Can't reach database server");
    mocks.withReplicaFallback.mockImplementation(() => Promise.reject(down));

    await expect(findStreams({ limit: 10, offset: 0 })).rejects.toBe(down);
  });

  it('rejects when the count fails even though the page succeeded', async () => {
    mocks.replica.stream.findMany.mockResolvedValue([{ streamId: 1n }]);
    mocks.replica.stream.count.mockRejectedValue(prismaKnown('P2023', 'Query failed'));

    await expect(findStreams({ limit: 10, offset: 0 })).rejects.toThrow('Query failed');
  });
});
