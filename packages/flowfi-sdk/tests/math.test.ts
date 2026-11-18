import { describe, it, expect } from 'vitest';
import {
  calculateRatePerSecond,
  calculateAlignedDeposit,
  calculateRequiredDeposit,
} from '../src/math.js';

describe('Math utilities (#1658)', () => {
  describe('calculateRatePerSecond', () => {
    it('calculates rate per second with pure bigint division', () => {
      expect(calculateRatePerSecond(1_000n, 100n)).toBe(10n);
      expect(calculateRatePerSecond(1_000_000_0000000n, 86400n)).toBe(115740740n);
    });

    it('performs integer division without floating-point precision loss', () => {
      // 1005 / 100 = 10 (remainder 5)
      expect(calculateRatePerSecond(1005n, 100n)).toBe(10n);
    });

    it('throws RangeError if totalAmount <= 0n', () => {
      expect(() => calculateRatePerSecond(0n, 100n)).toThrow(RangeError);
      expect(() => calculateRatePerSecond(-50n, 100n)).toThrow(RangeError);
      expect(() => calculateRatePerSecond(0n, 100n)).toThrow(
        'calculateRatePerSecond: totalAmount must be greater than 0',
      );
    });

    it('throws RangeError if durationSeconds <= 0n', () => {
      expect(() => calculateRatePerSecond(1000n, 0n)).toThrow(RangeError);
      expect(() => calculateRatePerSecond(1000n, -10n)).toThrow(RangeError);
      expect(() => calculateRatePerSecond(1000n, 0n)).toThrow(
        'calculateRatePerSecond: durationSeconds must be greater than 0',
      );
    });
  });

  describe('calculateAlignedDeposit', () => {
    it('calculates total aligned deposit from rate and duration', () => {
      expect(calculateAlignedDeposit(10n, 100n)).toBe(1000n);
      expect(calculateAlignedDeposit(11574074n, 86400n)).toBe(999999993600n);
    });

    it('throws RangeError if ratePerSecond <= 0n', () => {
      expect(() => calculateAlignedDeposit(0n, 100n)).toThrow(RangeError);
      expect(() => calculateAlignedDeposit(-5n, 100n)).toThrow(RangeError);
      expect(() => calculateAlignedDeposit(0n, 100n)).toThrow(
        'calculateAlignedDeposit: ratePerSecond must be greater than 0',
      );
    });

    it('throws RangeError if durationSeconds <= 0n', () => {
      expect(() => calculateAlignedDeposit(10n, 0n)).toThrow(RangeError);
      expect(() => calculateAlignedDeposit(10n, -10n)).toThrow(RangeError);
      expect(() => calculateAlignedDeposit(10n, 0n)).toThrow(
        'calculateAlignedDeposit: durationSeconds must be greater than 0',
      );
    });
  });

  describe('calculateRequiredDeposit alias', () => {
    it('is aliased to calculateAlignedDeposit', () => {
      expect(calculateRequiredDeposit).toBe(calculateAlignedDeposit);
      expect(calculateRequiredDeposit(50n, 20n)).toBe(1000n);
    });
  });
});
