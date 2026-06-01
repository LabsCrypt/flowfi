import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cache, isRedisAvailable } from '../src/lib/redis.js';

describe('Memory Cache', () => {
  it('should set and get values', () => {
    cache.set('key1', 'value1', 10);
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return null for expired values', () => {
    vi.useFakeTimers();
    cache.set('key-exp', 'value1', 1);
    vi.advanceTimersByTime(1500);
    expect(cache.get('key-exp')).toBeNull();
    vi.useRealTimers();
  });

  it('should delete values', () => {
    cache.set('key-del', 'value1', 10);
    cache.del('key-del');
    expect(cache.get('key-del')).toBeNull();
  });

  it('should return stats', () => {
    const initialStats = cache.getStats();
    cache.set('key-stats', 'value1', 10);
    cache.get('key-stats');
    cache.get('key-missing');
    const finalStats = cache.getStats();
    expect(finalStats.hits).toBe(initialStats.hits + 1);
    expect(finalStats.misses).toBe(initialStats.misses + 1);
  });
});

describe('Redis Available', () => {
  it('should return false if redis not initialized', () => {
    expect(isRedisAvailable()).toBe(false);
  });
});
