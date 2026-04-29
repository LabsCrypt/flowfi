/**
 * Redis / In-Memory Cache Service
 * Used for horizontal SSE scaling and claimable amount caching (Issue #377)
 */
import { Redis } from 'ioredis';
import logger from '../logger.js';

const REDIS_URL = process.env.REDIS_URL;

let _publisher: Redis | null = null;
let _subscriber: Redis | null = null;
let _available = false;

// --- Memory Cache for Claimable Amounts (Issue #377) ---
interface CacheItem<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

class MemoryCache {
  private cache = new Map<string, CacheItem<any>>();
  private hits = 0;
  private misses = 0;

  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) {
      this.misses++;
      return null;
    }
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return item.value;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    const now = Date.now();
    this.cache.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  del(key: string): void {
    this.cache.delete(key);
  }

  getMetadata(key: string) {
    const item = this.cache.get(key);
    if (!item) return null;
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
    };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

export const cache = new MemoryCache();
setInterval(() => cache.cleanup(), 60000);

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
  await Promise.all([_publisher?.quit(), _subscriber?.quit()]);
  _publisher = null;
  _subscriber = null;
  _available = false;
}
