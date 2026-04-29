/**
 * MemoryCache - A simple in-memory cache with Redis-like interface
 * Used for claimable amount caching (Issue #377)
 */

interface CacheItem<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

class MemoryCache {
  private cache = new Map<string, CacheItem<any>>();
  private hits = 0;
  private misses = 0;

  /**
   * Get a value from the cache
   */
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

  /**
   * Set a value in the cache with TTL in seconds
   */
  set<T>(key: string, value: T, ttlSeconds: number): void {
    const now = Date.now();
    this.cache.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  /**
   * Delete a key from the cache
   */
  del(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Get cache metadata (for returning in API response)
   */
  getMetadata(key: string) {
    const item = this.cache.get(key);
    if (!item) return null;
    return {
      createdAt: new Date(item.createdAt).toISOString(),
      expiresAt: new Date(item.expiresAt).toISOString(),
    };
  }

  /**
   * Get metrics for admin dashboard
   */
  getStats() {
    const totalRequests = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: totalRequests > 0 ? (this.hits / totalRequests) * 100 : 0,
      itemCount: this.cache.size,
    };
  }

  /**
   * Clear expired items (background cleanup)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

// Export a singleton instance
export const cache = new MemoryCache();

// Run cleanup every minute
setInterval(() => cache.cleanup(), 60000);
