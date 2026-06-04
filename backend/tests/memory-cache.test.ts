import { afterEach, describe, expect, it, vi } from 'vitest';
import { cache } from '../src/lib/redis.js';

describe('MemoryCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('set+get returns value', () => {
    const key = 'memory-cache-set-get';
    cache.set(key, 'value', 10);
    expect(cache.get(key)).toBe('value');
  });

  it('set with 0 TTL is immediately expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const key = 'memory-cache-zero-ttl';
    cache.set(key, 'value', 0);

    expect(cache.get(key)).toBeNull();
  });

  it('expired entries are pruned by cleanup()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    const key = 'memory-cache-expired';
    const initialStats = cache.getStats();

    cache.set(key, 'value', 1);
    vi.advanceTimersByTime(1500);
    cache.cleanup();

    expect(cache.get(key)).toBeNull();
    expect(cache.getStats().itemCount).toBe(initialStats.itemCount);
  });

  it('del() removes an entry', () => {
    const key = 'memory-cache-delete';
    cache.set(key, 'value', 10);
    cache.del(key);
    expect(cache.get(key)).toBeNull();
  });

  it('getStats() reflects hits, misses, and itemCount', () => {
    const key = 'memory-cache-stats';
    const missingKey = 'memory-cache-stats-missing';
    const initialStats = cache.getStats();

    cache.set(key, 'value', 10);
    cache.get(key);
    cache.get(missingKey);

    const finalStats = cache.getStats();
    expect(finalStats.hits).toBe(initialStats.hits + 1);
    expect(finalStats.misses).toBe(initialStats.misses + 1);
    expect(finalStats.itemCount).toBe(initialStats.itemCount + 1);
  });

  it('getMetadata() returns ISO timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);

    const key = 'memory-cache-metadata';
    cache.set(key, 'value', 10);

    const metadata = cache.getMetadata(key);
    expect(metadata).not.toBeNull();
    expect(metadata).toEqual({
      createdAt: new Date(3000).toISOString(),
      expiresAt: new Date(13000).toISOString(),
    });
  });
});
