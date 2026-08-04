import { describe, it, expect } from 'vitest';
import { createStreamSchema } from '../src/validators/stream.validator.js';

describe('Stream Validator', () => {
  it('should validate valid stream data', () => {
    const validData = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '1000',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(validData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streamId).toBe(123n);
    }
  });

  it('accepts a u64 streamId above int4 max (#829)', () => {
    const result = createStreamSchema.safeParse({
      streamId: '3000000000',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '1000',
      startTime: 1622505600,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streamId).toBe(3_000_000_000n);
    }
  });

  it('should fail on invalid stream data', () => {
    const invalidData = {
      streamId: -1,
      sender: '',
      recipient: '',
      tokenAddress: '',
      ratePerSecond: 'abc',
      depositedAmount: '-100',
      startTime: 'not-a-timestamp',
    };
    const result = createStreamSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('should reject ratePerSecond exceeding i128 max', () => {
    const data = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '170141183460469231731687303715884105728',
      depositedAmount: '1000',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(data);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe('Rate exceeds maximum allowed value');
  });

  it('should accept ratePerSecond at i128 max', () => {
    const data = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '170141183460469231731687303715884105727',
      depositedAmount: '1000',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
