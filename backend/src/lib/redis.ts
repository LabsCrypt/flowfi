/**
 * Redis Pub/Sub Service and Per-Instance Memory Cache
 *
 * Redis (when configured) provides horizontal SSE scaling via pub/sub.
 * The claimable-amount cache is a per-process in-memory Map (MemoryCache),
 * NOT Redis-backed.  Each instance computes and caches independently, so
 * cached values are not shared across horizontal replicas.
 */
import { Redis } from 'ioredis';
import logger from '../logger.js';

const REDIS_URL = process.env.REDIS_URL;

let _publisher: Redis | null = null;
let _subscriber: Redis | null = null;
let _available = false;

// --- Per-Instance In-Memory Cache for Claimable Amounts (Issue #377) ---
// NOTE: This cache lives in-process only. It is NOT shared via Redis and
// will not be consistent across horizontally scaled instances.
interface CacheItem<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

interface MemoryCacheOptions {
  /**
   * Hard cap on the number of entries kept in memory. When exceeded, the
   * least-recently-used entries are evicted immediately (Issue #1249), so the
   * cache is bounded even between timed cleanup() sweeps.
   */
  maxItems?: number;
}

const DEFAULT_MEMORY_CACHE_MAX_ITEMS = 10_000;

/**
 * LRU-bounded in-memory cache. Entries are ordered by recency (most-recently
 * used at the end of the Map), and a max-size cap is enforced on every set so
 * memory usage stays bounded regardless of key churn or sweep interval.
 */
export class MemoryCache {
  private cache = new Map<string, CacheItem<any>>();
  private hits = 0;
  private misses = 0;
  private readonly maxItems: number;

  constructor(options: MemoryCacheOptions = {}) {
    const configuredMax = Number.parseInt(
      process.env.MEMORY_CACHE_MAX_ITEMS ?? '',
      10,
    );
    const envMax =
      Number.isFinite(configuredMax) && configuredMax > 0
        ? configuredMax
        : DEFAULT_MEMORY_CACHE_MAX_ITEMS;
    this.maxItems = options.maxItems ?? envMax;
  }

  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) {
      this.misses++;
      return null;
    }
    if (Date.now() >= item.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    // Refresh LRU recency: re-insert at the end of the Map so this entry is
    // the last candidate for eviction when the max-size cap is hit.
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    const now = Date.now();
    // Delete-then-set so overwrites also move to the most-recently-used end.
    this.cache.delete(key);
    this.cache.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });
    this.evictIfOverCapacity();
  }

  del(key: string): void {
    this.cache.delete(key);
  }

  getMetadata(key: string) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() >= item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    // Same recency refresh as get(): active metadata reads keep entries alive.
    this.cache.delete(key);
    this.cache.set(key, item);
    return {
      createdAt: new Date(item.createdAt).toISOString(),
      expiresAt: new Date(item.expiresAt).toISOString(),
    };
  }

  getStats() {
    const totalRequests = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: totalRequests > 0 ? (this.hits / totalRequests) * 100 : 0,
      itemCount: this.cache.size,
      maxItems: this.maxItems,
    };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now >= item.expiresAt) {
        this.cache.delete(key);
      }
    }
    this.evictIfOverCapacity();
  }

  private evictIfOverCapacity(): void {
    // Evict from the front of the Map (least-recently-used) until under cap.
    while (this.cache.size > this.maxItems) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }
}

export const cache = new MemoryCache();

let sweepInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Starts the memory cache cleanup sweep interval.
 * Uses process.env.MEMORY_CACHE_SWEEP_MS (default 60,000ms) unless overridden.
 * The sweep only prunes expired entries; the LRU max-size cap (MEMORY_CACHE_MAX_ITEMS)
 * is enforced independently on every set (Issue #1249).
 */
export function startMemoryCacheSweep(intervalMs?: number): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
  }
  
  const configuredMs = Number.parseInt(
    process.env.MEMORY_CACHE_SWEEP_MS ?? '60000',
    10
  );
  const ms = intervalMs ?? (Number.isFinite(configuredMs) ? configuredMs : 60000);
  
  sweepInterval = setInterval(() => cache.cleanup(), ms);
}

/**
 * Stops the active memory cache cleanup sweep interval to prevent timer leaks.
 */
export function stopMemoryCacheSweep(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = undefined;
  }
}

// Start memory cache sweep automatically on module load
startMemoryCacheSweep();

// --- Redis Pub/Sub Logic ---

export function getPublisher(): Redis | null {
  return _publisher;
}

/**
 * The shared Redis client backing general-purpose data structures (sorted
 * sets, counters) as opposed to pub/sub. Returns null when Redis is not
 * configured or failed to connect, so callers can fall back gracefully.
 */
export function getRedisClient(): Redis | null {
  return _publisher;
}

export function getSubscriber(): Redis | null {
  return _subscriber;
}

export function isRedisAvailable(): boolean {
  return _available;
}

function makeClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) =>
      times > 3 ? null : Math.min(times * 200, 2000),
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

export async function connectRedis(): Promise<void> {
  if (!REDIS_URL) {
    logger.info('[Redis] REDIS_URL not set — running in single-instance SSE mode.');
    return;
  }

  try {
    const publisher = makeClient(REDIS_URL);
    const subscriber = makeClient(REDIS_URL);

    await Promise.all([publisher.connect(), subscriber.connect()]);
    _publisher = publisher;
    _subscriber = subscriber;
    _available = true;

    logger.info('[Redis] Connected — horizontal SSE scaling enabled.');
  } catch (err) {
    logger.warn(
      '[Redis] Connection failed — falling back to single-instance SSE mode:',
      err
    );

    _publisher?.disconnect();
    _subscriber?.disconnect();
    _publisher = null;
    _subscriber = null;
    _available = false;
  }
}

export async function disconnectRedis(): Promise<void> {
  stopMemoryCacheSweep();
  await Promise.all([_publisher?.quit(), _subscriber?.quit()]);
  _publisher = null;
  _subscriber = null;
  _available = false;
}

// --- Sliding-Window Event Tracker (Issue #1469) ---
//
// The stream-drain sentinel needs rolling-window aggregates over
// high-frequency events (withdrawals, stream creations). Redis sorted sets
// give O(log N) inserts plus a range query whose lower bound ages entries out
// via ZREMRANGEBYSCORE. When Redis is not configured (single-instance
// deployments and the unit-test suite) the identical interface is backed by a
// process-local Map so anomaly detection degrades instead of disappearing.
//
// Each sample's numeric weight (the withdrawal volume, or a constant 1 for
// pure counts) is encoded into the sorted-set member as `${id}:${weight}`.
// That lets one key answer both "how many events?" (member count) and
// "how much volume?" (sum of the weights) without a second round-trip.

export interface SlidingWindowSnapshot {
  /** Number of samples currently inside the window. */
  count: number;
  /** Sum of the sample weights currently inside the window. */
  sum: number;
  /** Epoch milliseconds of the oldest sample, or null when the window is empty. */
  firstAt: number | null;
  /** Epoch milliseconds of the newest sample, or null when the window is empty. */
  lastAt: number | null;
}

export interface SlidingWindowTracker {
  /**
   * Insert a sample. `id` deduplicates: re-adding the same id refreshes its
   * timestamp instead of creating a second entry (used for "distinct streams").
   */
  add(key: string, id: string, weight?: number, at?: number): Promise<void>;
  /** Aggregate every sample newer than `now - windowMs`. */
  snapshot(key: string, windowMs: number, now?: number): Promise<SlidingWindowSnapshot>;
  /** Count of distinct ids inside the window. */
  distinct(key: string, windowMs: number, now?: number): Promise<number>;
  /** Drop a key entirely (used by tests and admin resets). */
  clear(key: string): Promise<void>;
}

const EMPTY_SNAPSHOT: SlidingWindowSnapshot = {
  count: 0,
  sum: 0,
  firstAt: null,
  lastAt: null,
};

function encodeMember(id: string, weight: number): string {
  return `${id}:${weight}`;
}

function decodeWeight(member: string): number {
  const separator = member.lastIndexOf(':');
  if (separator === -1) return 1;
  const parsed = Number.parseFloat(member.slice(separator + 1));
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * In-memory fallback used when Redis is unavailable. Bounded per key so a
 * sustained attack cannot grow memory without limit; oldest samples are
 * evicted first.
 */
export class InMemorySlidingWindowTracker implements SlidingWindowTracker {
  private windows = new Map<string, Map<string, { score: number; weight: number }>>();
  private readonly maxSamplesPerKey: number;

  constructor(maxSamplesPerKey = 5_000) {
    this.maxSamplesPerKey = maxSamplesPerKey;
  }

  async add(key: string, id: string, weight = 1, at = Date.now()): Promise<void> {
    let window = this.windows.get(key);
    if (!window) {
      window = new Map();
      this.windows.set(key, window);
    }
    const member = encodeMember(id, weight);
    window.delete(member); // refresh recency on re-insert
    window.set(member, { score: at, weight });

    // Age out before bounding by size: a sample outside every supported
    // window can never be read again, so dropping it is safe. Window
    // *reads* must not prune (a narrow read would destroy the data a wider
    // baseline read needs).
    const retentionCutoff = at - DEFAULT_TRACKER_RETENTION_MS;
    for (const [existing, sample] of window) {
      if (sample.score < retentionCutoff) window.delete(existing);
    }

    while (window.size > this.maxSamplesPerKey) {
      const oldest = window.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      window.delete(oldest);
    }
  }

  async snapshot(
    key: string,
    windowMs: number,
    now = Date.now(),
  ): Promise<SlidingWindowSnapshot> {
    const window = this.windows.get(key);
    if (!window || window.size === 0) return { ...EMPTY_SNAPSHOT };

    const cutoff = now - windowMs;
    let count = 0;
    let sum = 0;
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const sample of window.values()) {
      if (sample.score < cutoff) continue;
      count += 1;
      sum += sample.weight;
      if (firstAt === null || sample.score < firstAt) firstAt = sample.score;
      if (lastAt === null || sample.score > lastAt) lastAt = sample.score;
    }

    return { count, sum, firstAt, lastAt };
  }

  async distinct(key: string, windowMs: number, now = Date.now()): Promise<number> {
    return (await this.snapshot(key, windowMs, now)).count;
  }

  async clear(key: string): Promise<void> {
    this.windows.delete(key);
  }
}

/** Redis sorted-set backed tracker. */
export class RedisSlidingWindowTracker implements SlidingWindowTracker {
  constructor(private readonly redis: Redis) {}

  async add(key: string, id: string, weight = 1, at = Date.now()): Promise<void> {
    const member = encodeMember(id, weight);
    await this.redis.zremrangebyscore(key, '-inf', at - DEFAULT_TRACKER_RETENTION_MS);
    await this.redis.zadd(key, at, member);
    await this.redis.pexpire(key, DEFAULT_TRACKER_RETENTION_MS);
  }

  async snapshot(
    key: string,
    windowMs: number,
    now = Date.now(),
  ): Promise<SlidingWindowSnapshot> {
    // Read-only: `add` owns retention pruning. Pruning here would let a
    // narrow-window read delete the long-range history a baseline read needs.
    const cutoff = now - windowMs;
    const raw = (await this.redis.zrangebyscore(
      key,
      cutoff,
      '+inf',
      'WITHSCORES',
    )) as string[];

    let count = 0;
    let sum = 0;
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    // zrangebyscore(...WITHSCORES) returns [member, score, member, score, ...]
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i] ?? '';
      const score = Number.parseFloat(raw[i + 1] ?? '');
      count += 1;
      sum += decodeWeight(member);
      if (Number.isFinite(score)) {
        if (firstAt === null || score < firstAt) firstAt = score;
        if (lastAt === null || score > lastAt) lastAt = score;
      }
    }

    if (count === 0) return { ...EMPTY_SNAPSHOT };
    return { count, sum, firstAt, lastAt };
  }

  async distinct(key: string, windowMs: number, now = Date.now()): Promise<number> {
    const cutoff = now - windowMs;
    return this.redis.zcount(key, cutoff, '+inf');
  }

  async clear(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/** Samples older than this are pruned on every insert so keys never grow unbounded. */
const DEFAULT_TRACKER_RETENTION_MS = 24 * 60 * 60 * 1000;

let _tracker: SlidingWindowTracker | null = null;

/**
 * Resolve the process-wide sliding-window tracker, preferring Redis when a
 * client is connected and transparently using the in-memory fallback
 * otherwise.
 */
export function getSlidingWindowTracker(): SlidingWindowTracker {
  const redis = getRedisClient();
  if (redis) {
    return new RedisSlidingWindowTracker(redis);
  }
  if (!_tracker) {
    _tracker = new InMemorySlidingWindowTracker();
  }
  return _tracker;
}
