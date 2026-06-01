import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  cache,
  isRedisAvailable,
  startMemoryCacheSweep,
  stopMemoryCacheSweep,
} from '../src/lib/redis.js';

describe('Memory Cache', () => {
  afterAll(() => {
    stopMemoryCacheSweep();
  });

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

describe('Memory Cache Sweep Config', () => {
  afterAll(() => {
    stopMemoryCacheSweep();
  });

  it('should allow starting and stopping sweep interval', () => {
    vi.useFakeTimers();
    const cleanupSpy = vi.spyOn(cache, 'cleanup');
    
    // Stop any existing sweep and start a fresh one with 1000ms interval
    stopMemoryCacheSweep();
    startMemoryCacheSweep(1000);
    
    vi.advanceTimersByTime(2500);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    
    // Stop sweep and ensure no more calls happen
    stopMemoryCacheSweep();
    vi.advanceTimersByTime(2000);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    
    cleanupSpy.mockRestore();
    vi.useRealTimers();
  });

  it('should respect MEMORY_CACHE_SWEEP_MS env variable', () => {
    vi.useFakeTimers();
    const cleanupSpy = vi.spyOn(cache, 'cleanup');
    
    const originalEnv = process.env.MEMORY_CACHE_SWEEP_MS;
    process.env.MEMORY_CACHE_SWEEP_MS = '500';
    
    stopMemoryCacheSweep();
    startMemoryCacheSweep();
    
    vi.advanceTimersByTime(1200);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    
    stopMemoryCacheSweep();
    
    if (originalEnv === undefined) {
      delete process.env.MEMORY_CACHE_SWEEP_MS;
    } else {
      process.env.MEMORY_CACHE_SWEEP_MS = originalEnv;
    }
    cleanupSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('Redis Available', () => {
  it('should return false if redis not initialized', () => {
    expect(isRedisAvailable()).toBe(false);
  });
});
