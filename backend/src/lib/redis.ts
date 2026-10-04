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
