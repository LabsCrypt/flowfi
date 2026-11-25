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

  it('should reject depositedAmount exceeding i128 max (#1532)', () => {
    const data = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '170141183460469231731687303715884105728',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(data);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe('Amount exceeds maximum allowed value');
  });

  it('should accept depositedAmount at i128 max (#1532)', () => {
    const data = {
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '100',
      depositedAmount: '170141183460469231731687303715884105727',
      startTime: 1622505600,
    };
    const result = createStreamSchema.safeParse(data);
    expect(result.success).toBe(true);
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

  it('accepts zero numeric strings at the schema boundary', () => {
    const result = createStreamSchema.safeParse({
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '0',
      depositedAmount: '0',
      startTime: '0',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        ratePerSecond: '0',
        depositedAmount: '0',
        startTime: 0,
      });
    }
  });

  it.each([
    ['ratePerSecond', '1.5'],
    ['depositedAmount', '1.5'],
  ])('rejects decimal-string %s values', (field, value) => {
    const result = createStreamSchema.safeParse({
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '1',
      depositedAmount: '10',
      startTime: '0',
      [field]: value,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
  });

  it.each([
    ['ratePerSecond', '170141183460469231731687303715884105727'],
    ['depositedAmount', '170141183460469231731687303715884105727'],
  ])('accepts %s at the i128 upper bound', (field, value) => {
    const result = createStreamSchema.safeParse({
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '1',
      depositedAmount: '1',
      startTime: '0',
      [field]: value,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unsafe numeric stream id instead of rounding it', () => {
    const result = createStreamSchema.safeParse({
      streamId: Number.MAX_SAFE_INTEGER + 1,
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '1',
      depositedAmount: '1',
      startTime: '0',
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['numeric', Number.MAX_SAFE_INTEGER + 1],
    ['decimal-string', '9007199254740992'],
  ])('rejects an unsafe %s start time instead of rounding it', (_label, startTime) => {
    const result = createStreamSchema.safeParse({
      streamId: '123',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      tokenAddress: 'TABC',
      ratePerSecond: '1',
      depositedAmount: '1',
      startTime,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'startTime')).toBe(true);
    }
  });
});
