import { describe, it, expect } from 'vitest';
import { parseStreamId, streamIdToJson } from '../src/lib/stream-id.js';

describe('parseStreamId (#829)', () => {
  it('parses decimal strings and numbers into bigint', () => {
    expect(parseStreamId('42')).toBe(42n);
    expect(parseStreamId(42)).toBe(42n);
    expect(parseStreamId(42n)).toBe(42n);
  });

  it('parses values above int4 max without losing precision', () => {
    expect(parseStreamId('3000000000')).toBe(3_000_000_000n);
    expect(parseStreamId(3_000_000_000)).toBe(3_000_000_000n);
  });

  it('rejects negatives, non-integers, and non-decimal input', () => {
    expect(parseStreamId(-1)).toBeNull();
    expect(parseStreamId('abc')).toBeNull();
    expect(parseStreamId('12.5')).toBeNull();
    expect(parseStreamId(1.5)).toBeNull();
    expect(parseStreamId(undefined)).toBeNull();
  });

  it('serializes safe integers as numbers and larger values as strings', () => {
    expect(streamIdToJson(42n)).toBe(42);
    expect(streamIdToJson(3_000_000_000n)).toBe(3_000_000_000);
    const huge = (1n << 60n);
    expect(streamIdToJson(huge)).toBe(huge.toString());
  });
});
