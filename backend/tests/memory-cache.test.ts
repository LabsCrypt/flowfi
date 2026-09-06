import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache, cache } from '../src/lib/redis.js';

describe('MemoryCache', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MEMORY_CACHE_MAX_ITEMS;
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

describe('MemoryCache LRU eviction', () => {
  it('evicts least-recently-used entries once maxItems is exceeded, without waiting for cleanup', () => {
    const lru = new MemoryCache({ maxItems: 3 });

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    // Fourth set pushes the oldest entry ('a') out immediately.
    lru.set('d', 4, 10);

    expect(lru.get('a')).toBeNull();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
    expect(lru.getStats().itemCount).toBe(3);
  });

  it('get() refreshes recency so recently read entries survive eviction', () => {
    const lru = new MemoryCache({ maxItems: 3 });

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    // Reading 'a' makes it most-recently-used, so 'b' becomes the LRU entry.
    expect(lru.get('a')).toBe(1);
    lru.set('d', 4, 10);

    expect(lru.get('b')).toBeNull();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
  });

  it('overwriting an existing key refreshes its recency', () => {
    const lru = new MemoryCache({ maxItems: 3 });

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    // Refreshing 'a' (delete + set) makes it MRU; 'b' is now the LRU entry.
    lru.set('a', 10, 10);
    lru.set('d', 4, 10);

    expect(lru.get('b')).toBeNull();
    expect(lru.get('a')).toBe(10);
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
  });

  it('cleanup() also enforces the max-size cap after pruning expired entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const lru = new MemoryCache({ maxItems: 3 });
    lru.set('expired', 'x', 0); // immediately expired
    lru.set('a', 1, 60);
    lru.set('b', 2, 60);
    lru.set('c', 3, 60);

    lru.cleanup();

    expect(lru.getStats().itemCount).toBe(3);
    expect(lru.get('expired')).toBeNull();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
  });

  it('maxItems can be configured via MEMORY_CACHE_MAX_ITEMS env var', () => {
    process.env.MEMORY_CACHE_MAX_ITEMS = '2';
    const lru = new MemoryCache();

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    expect(lru.get('a')).toBeNull();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
    expect(lru.getStats().maxItems).toBe(2);
  });

  it('getStats() reports the configured maxItems', () => {
    const lru = new MemoryCache({ maxItems: 42 });
    expect(lru.getStats().maxItems).toBe(42);
  });

  it('keeps memory bounded under sustained load across many keys (Issue #1249 acceptance criteria)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const lru = new MemoryCache({ maxItems: 100 });

    // Simulate sustained polling across many streams, generating far more
    // unique keys (one per stream per timestamp bucket) than the cap.
    for (let tick = 0; tick < 500; tick += 1) {
      for (let stream = 0; stream < 50; stream += 1) {
        const key = `claimable:${stream}:state:${tick}`;
        lru.set(key, `value-${tick}-${stream}`, 5);
      }
      // Occasionally read an older key to exercise recency refresh.
      if (tick % 7 === 0) {
        lru.get(`claimable:0:state:${tick - 3}`);
      }
      expect(lru.getStats().itemCount).toBeLessThanOrEqual(100);
      vi.advanceTimersByTime(100);
    }

    // Never grows linearly with the number of requests — always bounded by cap.
    expect(lru.getStats().itemCount).toBeLessThanOrEqual(100);
  });
});
