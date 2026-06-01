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
});
