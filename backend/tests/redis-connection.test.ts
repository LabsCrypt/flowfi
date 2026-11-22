/**
 * Issue #1749: Redis connect, reconnect policy, command failure and the
 * unavailable-server fallback.
 *
 * The existing coverage stops at the in-memory cache (`tests/redis.test.ts`,
 * `tests/memory-cache.test.ts`) and at the tracker's happy path
 * (`tests/sentinel-service.test.ts`); everywhere else `src/lib/redis.js` is
 * `vi.mock`-ed away. Nothing tested `connectRedis`, `disconnectRedis`, the
 * reconnect schedule, or what the sliding-window tracker does when the
 * dependency is missing or answers badly — which is the whole of how this
 * service survives a Redis outage.
 *
 * Note on "command timeout" in the issue text: `makeClient` sets no
 * per-command timeout. What bounds a command instead is
 * `enableOfflineQueue: false` (a command issued while the link is down rejects
 * immediately rather than sitting in a queue) together with
 * `maxRetriesPerRequest: 3`. Both are asserted below as the real contract.
 *
 * Two behaviours found here are deliberately *not* pinned, because they look
 * wrong rather than intended, and are reported in the pull request:
 *   - `connectRedis`'s catch calls `disconnect()` on module state it has
 *     assigned nothing to, so the client whose connect failed is never closed.
 *     A publisher that connected before its subscriber failed keeps its socket
 *     open while the app reports Redis unavailable.
 *   - `SlidingWindowTracker.add` documents `id` as the dedupe key, but the id
 *     is stored encoded together with the weight, so re-adding one id with a
 *     new weight keeps a second sample and `distinct()` counts it twice.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

interface FakeClient {
  url: string;
  options: Record<string, unknown>;
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  zremrangebyscore: ReturnType<typeof vi.fn>;
  zrangebyscore: ReturnType<typeof vi.fn>;
  zcount: ReturnType<typeof vi.fn>;
  pexpire: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  failConnect: false,
  instances: [] as unknown[],
  commands: [] as string[],
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    url: string;
    options: Record<string, unknown>;
    connected = false;

    constructor(url: string, options: Record<string, unknown>) {
      this.url = url;
      this.options = options;
      state.instances.push(this);
    }

    private record(name: string): void {
      state.commands.push(name);
    }

    connect = vi.fn(async () => {
      this.record('connect');
      if (state.failConnect) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      }
      this.connected = true;
    });

    quit = vi.fn(async () => {
      this.record('quit');
      this.connected = false;
      return 'OK';
    });

    disconnect = vi.fn(() => {
      this.record('disconnect');
      this.connected = false;
    });

    zadd = vi.fn(async () => {
      this.record('zadd');
      return 1;
    });

    zremrangebyscore = vi.fn(async () => {
      this.record('zremrangebyscore');
      return 0;
    });

    zrangebyscore = vi.fn(async () => {
      this.record('zrangebyscore');
      return [] as string[];
    });

    zcount = vi.fn(async () => {
      this.record('zcount');
      return 0;
    });

    pexpire = vi.fn(async () => {
      this.record('pexpire');
      return 1;
    });

    del = vi.fn(async () => {
      this.record('del');
      return 1;
    });
  }

  return { Redis: FakeRedis };
});

type RedisModule = typeof import('../src/lib/redis.js');

const TEST_URL = 'redis://127.0.0.1:6379';
const DAY_MS = 24 * 60 * 60 * 1_000;
const loaded: RedisModule[] = [];

/**
 * `REDIS_URL` is read once at module scope, so each scenario needs a fresh
 * import with the environment set first. Every module loaded here owns a
 * cleanup timer started at import, so they are all stopped afterwards.
 */
async function loadRedis(redisUrl?: string): Promise<RedisModule> {
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;
  vi.resetModules();
  const mod = (await import('../src/lib/redis.js')) as RedisModule;
  loaded.push(mod);
  return mod;
}

/**
 * The module returns `ioredis` types, which the mock replaces at runtime, so
 * every handle has to be read back through the fake. Indexing loudly beats an
 * `as` on `undefined` if a scenario constructs fewer clients than expected.
 */
function client(index: number): FakeClient {
  const instance = state.instances[index];
  if (!instance) throw new Error(`no Redis client constructed at index ${index}`);
  return instance as FakeClient;
}

function publisherOf(redis: RedisModule): FakeClient {
  return redis.getPublisher() as unknown as FakeClient;
}

function subscriberOf(redis: RedisModule): FakeClient {
  return redis.getSubscriber() as unknown as FakeClient;
}

function trackerOf(redis: RedisModule): ReturnType<RedisModule['getSlidingWindowTracker']> {
  return redis.getSlidingWindowTracker();
}

beforeEach(() => {
  state.instances.length = 0;
  state.commands.length = 0;
  state.failConnect = false;
});

afterEach(() => {
  for (const mod of loaded.splice(0)) {
    mod.stopMemoryCacheSweep();
  }
  delete process.env.REDIS_URL;
  state.instances.length = 0;
  state.commands.length = 0;
  state.failConnect = false;
});

describe('boot without Redis configured', () => {
  it('connects to nothing and reports itself single-instance', async () => {
    const redis = await loadRedis(undefined);

    await expect(redis.connectRedis()).resolves.toBeUndefined();

    expect(state.instances).toHaveLength(0);
    expect(redis.isRedisAvailable()).toBe(false);
    expect(redis.getPublisher()).toBeNull();
    expect(redis.getSubscriber()).toBeNull();
    expect(redis.getRedisClient()).toBeNull();
  });

  it('treats an empty REDIS_URL as unset instead of dialling an empty host', async () => {
    const redis = await loadRedis('');

    await redis.connectRedis();

    expect(state.instances).toHaveLength(0);
    expect(redis.isRedisAvailable()).toBe(false);
  });

  it('tolerates a disconnect that was never connected', async () => {
    const redis = await loadRedis(undefined);

    await expect(redis.disconnectRedis()).resolves.toBeUndefined();
    expect(state.instances).toHaveLength(0);
  });
});

describe('connect and reconnect', () => {
  it('opens one publisher and one subscriber and only then advertises availability', async () => {
    const redis = await loadRedis(TEST_URL);

    expect(redis.isRedisAvailable()).toBe(false);

    await redis.connectRedis();

    const publisher = client(0);
    const subscriber = client(1);
    expect(state.instances).toHaveLength(2);
    expect(publisher.url).toBe(TEST_URL);
    expect(subscriber.url).toBe(TEST_URL);
    // Separate connections: a client in subscriber mode cannot answer ordinary
    // commands, so sharing one would break `publish` against `psubscribe`.
    expect(publisher).not.toBe(subscriber);
    expect(publisher.connected).toBe(true);
    expect(subscriber.connected).toBe(true);
    expect(publisher.connect).toHaveBeenCalledTimes(1);
    expect(redis.isRedisAvailable()).toBe(true);
    expect(publisherOf(redis)).toBe(publisher);
    expect(subscriberOf(redis)).toBe(subscriber);
    expect(redis.getRedisClient()).toBe(publisher);
  });

  it('falls back to single-instance mode when the server is unreachable', async () => {
    state.failConnect = true;
    const redis = await loadRedis(TEST_URL);

    // A Redis outage must not take the API down with it, so the failure is
    // absorbed here rather than thrown at the boot caller.
    await expect(redis.connectRedis()).resolves.toBeUndefined();

    expect(redis.isRedisAvailable()).toBe(false);
    expect(redis.getPublisher()).toBeNull();
    expect(redis.getSubscriber()).toBeNull();
  });

  it('recovers horizontal mode when a retry succeeds after a failed connect', async () => {
    state.failConnect = true;
    const redis = await loadRedis(TEST_URL);
    await redis.connectRedis();
    expect(redis.isRedisAvailable()).toBe(false);

    state.failConnect = false;
    await redis.connectRedis();

    expect(redis.isRedisAvailable()).toBe(true);
    expect(publisherOf(redis)).toBe(client(2));
    expect(subscriberOf(redis)).toBe(client(3));
  });

  it('quits both clients and reverts to single-instance mode on shutdown', async () => {
    const redis = await loadRedis(TEST_URL);
    await redis.connectRedis();
    const publisher = client(0);
    const subscriber = client(1);

    await redis.disconnectRedis();

    expect(publisher.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    expect(publisher.connected).toBe(false);
    expect(subscriber.connected).toBe(false);
    expect(redis.isRedisAvailable()).toBe(false);
    expect(redis.getPublisher()).toBeNull();

    // Shutdown can be reached twice (signal handler plus test teardown).
    await expect(redis.disconnectRedis()).resolves.toBeUndefined();
    expect(publisher.quit).toHaveBeenCalledTimes(1);
  });
});

describe('reconnect and command-failure policy', () => {
  let publisher: FakeClient;
  let subscriber: FakeClient;

  beforeEach(async () => {
    const redis = await loadRedis(TEST_URL);
    await redis.connectRedis();
    publisher = client(0);
    subscriber = client(1);
  });

  it('declines to queue commands while the link is down', () => {
    // This is what bounds the wait a caller experiences; there is no separate
    // per-command timeout in this module.
    expect(publisher.options.enableOfflineQueue).toBe(false);
  });

  it('retries a command at most three times before rejecting it', () => {
    expect(publisher.options.maxRetriesPerRequest).toBe(3);
  });

  it('connects on demand so a Redis-less boot costs no socket', () => {
    expect(publisher.options.lazyConnect).toBe(true);
    expect(publisher.connect).toHaveBeenCalledTimes(1);
  });

  it('backs off 200ms, 400ms, 600ms and then stops retrying', () => {
    const retryStrategy = publisher.options.retryStrategy as (times: number) => number | null;

    expect(retryStrategy(1)).toBe(200);
    expect(retryStrategy(2)).toBe(400);
    expect(retryStrategy(3)).toBe(600);
    // `null` is ioredis for "give up"; the fourth gap must be a stop rather
    // than a longer wait, or a dead Redis is retried for the life of the
    // process by a service that never re-runs `connectRedis`.
    expect(retryStrategy(4)).toBeNull();
    expect(retryStrategy(50)).toBeNull();
  });

  it('hands the same policy to the subscriber as to the publisher', () => {
    // A subscriber that reconnects on a different schedule from the publisher
    // would leave SSE pub/sub permanently split across the outage. The option
    // bags cannot be compared whole — `makeClient` closes over a fresh
    // `retryStrategy` per client — so the scalars and both schedules are
    // checked separately.
    const { retryStrategy: publisherStrategy, ...publisherScalars } = publisher.options;
    const { retryStrategy: subscriberStrategy, ...subscriberScalars } = subscriber.options;

    expect(subscriberScalars).toEqual(publisherScalars);
    const strategy = subscriberStrategy as (times: number) => number | null;
    expect([1, 2, 3, 4].map(strategy)).toEqual([200, 400, 600, null]);
    expect(strategy).not.toBe(publisherStrategy);
  });
});

describe('sliding-window tracker against the connection state', () => {
  it('uses the in-memory window while Redis is absent and keeps one shared instance', async () => {
    const redis = await loadRedis(undefined);

    const first = trackerOf(redis);
    const second = trackerOf(redis);

    expect(first).toBe(second);
    expect(first).toBeInstanceOf(redis.InMemorySlidingWindowTracker);
  });

  it('routes through the publisher once Redis answers and back to memory after shutdown', async () => {
    const redis = await loadRedis(TEST_URL);
    await redis.connectRedis();
    const publisher = publisherOf(redis);

    const tracker = trackerOf(redis);
    expect(tracker).toBeInstanceOf(redis.RedisSlidingWindowTracker);

    await tracker.add('withdrawals', 'stream-1', 25, 1_000);
    expect(publisher.zadd).toHaveBeenCalledWith('withdrawals', 1_000, 'stream-1:25');

    await redis.disconnectRedis();
    publisher.zadd.mockClear();

    const fallback = trackerOf(redis);
    expect(fallback).toBeInstanceOf(redis.InMemorySlidingWindowTracker);
    await fallback.add('withdrawals', 'stream-1', 25, 1_000);
    expect(publisher.zadd).not.toHaveBeenCalled();
    expect((await fallback.snapshot('withdrawals', 10_000, 2_000)).count).toBe(1);
  });

  it('keeps detecting on the fallback when the connection failed at boot', async () => {
    state.failConnect = true;
    const redis = await loadRedis(TEST_URL);
    await redis.connectRedis();

    const tracker = trackerOf(redis);

    expect(tracker).toBeInstanceOf(redis.InMemorySlidingWindowTracker);
    await tracker.add('k', 'a', 1, 1_000);
    expect(await tracker.distinct('k', 60_000, 2_000)).toBe(1);
  });
});

describe('Redis command failures and bad replies', () => {
  let redis: RedisModule;
  let client0: FakeClient;
  let tracker: ReturnType<RedisModule['getSlidingWindowTracker']>;

  beforeEach(async () => {
    redis = await loadRedis(TEST_URL);
    await redis.connectRedis();
    client0 = client(0);
    tracker = trackerOf(redis);
  });

  it('ages a key out as part of the insert, before it writes the sample', async () => {
    state.commands.length = 0;

    await tracker.add('k', 'a', 1, 1_000);

    expect(state.commands).toEqual(['zremrangebyscore', 'zadd', 'pexpire']);
    expect(client0.zremrangebyscore).toHaveBeenCalledWith('k', '-inf', 1_000 - DAY_MS);
    expect(client0.pexpire).toHaveBeenCalledWith('k', DAY_MS);
  });

  it('lets a failed insert reach the caller instead of losing the sample quietly', async () => {
    client0.zadd.mockRejectedValue(
      new Error("READONLY You can't write against a read only replica."),
    );

    await expect(tracker.add('k', 'a', 1, 1_000)).rejects.toThrow(/READONLY/);
  });

  it('lets a failed read reach the caller instead of reporting an empty window', async () => {
    // An empty snapshot here would read as "no activity" to the sentinel, the
    // opposite of what a Redis timeout means.
    client0.zrangebyscore.mockRejectedValue(new Error('Connection is closed.'));

    await expect(tracker.snapshot('k', 60_000, 1_000)).rejects.toThrow(
      'Connection is closed.',
    );
  });

  it('does not mutate the window while reading it', async () => {
    state.commands.length = 0;

    await tracker.snapshot('k', 60_000, 100_000);

    // A narrow read that pruned would blind the long-range baseline read.
    expect(state.commands).toEqual(['zrangebyscore']);
    expect(client0.zrangebyscore).toHaveBeenCalledWith('k', 40_000, '+inf', 'WITHSCORES');
  });

  it('sums the weights out of members that embed id and weight together', async () => {
    client0.zrangebyscore.mockResolvedValue(['stream:42:12.5', '1000', 'stream:43:7', '2000']);

    expect(await tracker.snapshot('k', 60_000, 3_000)).toEqual({
      count: 2,
      sum: 19.5,
      firstAt: 1000,
      lastAt: 2000,
    });
  });

  it('degrades an unparsable weight to one event rather than dropping the sample', async () => {
    client0.zrangebyscore.mockResolvedValue(['legacy-member', 'NaN', 'no-separator', '2000']);

    const snapshot = await tracker.snapshot('k', 60_000, 3_000);

    // Both members still count as activity; the score that is not a number is
    // the one thing that cannot be reported as a timestamp.
    expect(snapshot.count).toBe(2);
    expect(snapshot.sum).toBe(2);
    expect(snapshot.firstAt).toBe(2000);
    expect(snapshot.lastAt).toBe(2000);
  });

  it('answers an empty window with zeroes and no timestamps', async () => {
    const first = await tracker.snapshot('k', 60_000, 1_000);
    const second = await tracker.snapshot('other', 60_000, 1_000);

    expect(first).toEqual({ count: 0, sum: 0, firstAt: null, lastAt: null });
    // A caller that writes to the snapshot must not be able to corrupt the
    // shared empty value handed to everyone else.
    expect(first).not.toBe(second);
    first.count = 99;
    expect(second.count).toBe(0);
  });

  it('counts distinct ids with ZCOUNT rather than reading the set back', async () => {
    client0.zcount.mockResolvedValue(4);

    expect(await tracker.distinct('k', 60_000, 100_000)).toBe(4);
    expect(client0.zcount).toHaveBeenCalledWith('k', 40_000, '+inf');
    expect(client0.zrangebyscore).not.toHaveBeenCalled();
  });

  it('clears a window with DEL', async () => {
    await tracker.clear('k');

    expect(client0.del).toHaveBeenCalledWith('k');
  });
});

describe('in-memory window bounding', () => {
  it('keeps history a narrow read could have pruned', async () => {
    const redis = await loadRedis(undefined);
    const tracker = new redis.InMemorySlidingWindowTracker();
    await tracker.add('k', 'a', 1, 0);
    await tracker.add('k', 'b', 1, 1_000);

    expect((await tracker.snapshot('k', 500, 1_000)).count).toBe(1);
    // The sentinel reads a short burst window and a long baseline window off
    // the same key, so the first read must not consume the second's data.
    expect((await tracker.snapshot('k', DAY_MS, 1_000)).count).toBe(2);
  });

  it('drops samples past the retention age on the next insert', async () => {
    const redis = await loadRedis(undefined);
    const tracker = new redis.InMemorySlidingWindowTracker();
    await tracker.add('k', 'ancient', 1, 0);
    await tracker.add('k', 'recent', 1, DAY_MS + 1_000);

    const snapshot = await tracker.snapshot('k', DAY_MS * 2, DAY_MS + 1_000);

    expect(snapshot.count).toBe(1);
    expect(snapshot.firstAt).toBe(DAY_MS + 1_000);
  });

  it('evicts the oldest samples once a key is over its cap', async () => {
    const redis = await loadRedis(undefined);
    const tracker = new redis.InMemorySlidingWindowTracker(3);
    const samples: Array<[string, number]> = [
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
      ['e', 5],
    ];
    for (const [id, at] of samples) {
      await tracker.add('k', id, 1, at);
    }

    const snapshot = await tracker.snapshot('k', DAY_MS * 2, 5);

    // Bounded without waiting for a sweep, and it is the oldest that goes
    // rather than an arbitrary member.
    expect(snapshot.count).toBe(3);
    expect(snapshot.firstAt).toBe(3);
    expect(snapshot.lastAt).toBe(5);
  });

  it('refreshes an existing id in place rather than doubling it', async () => {
    const redis = await loadRedis(undefined);
    const tracker = new redis.InMemorySlidingWindowTracker();
    await tracker.add('k', 'stream-1', 1, 1_000);
    await tracker.add('k', 'stream-1', 1, 2_000);

    const snapshot = await tracker.snapshot('k', DAY_MS, 2_000);

    expect(snapshot).toMatchObject({ count: 1, firstAt: 2_000, lastAt: 2_000 });
  });

  it('answers for a key that was never written', async () => {
    const redis = await loadRedis(undefined);
    const tracker = new redis.InMemorySlidingWindowTracker();

    expect(await tracker.snapshot('missing', 1_000, 1_000)).toEqual({
      count: 0,
      sum: 0,
      firstAt: null,
      lastAt: null,
    });
    expect(await tracker.distinct('missing', 1_000, 1_000)).toBe(0);
  });
});
