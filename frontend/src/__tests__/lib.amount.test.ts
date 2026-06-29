import { describe, it, expect } from 'vitest';
import {
  formatAmount,
  parseAmount,
  formatRate,
  hasValidPrecision,
  truncateAmount,
  formatCompactAmount,
  toStroops,
  fromStroops,
} from '../lib/amount';

describe('lib/amount.ts - formatAmount', () => {
  it('converts raw i128 stroops to token units', () => {
    expect(formatAmount(10000000n, 7)).toBe('1');
    expect(formatAmount(50000000n, 7)).toBe('5');
    expect(formatAmount(0n, 7)).toBe('0');
  });

  it('handles fractional results', () => {
    expect(formatAmount(5000000n, 7)).toBe('0.5');
    expect(formatAmount(1n, 7)).toBe('0.0000001');
  });

  it('removes trailing zeros from fractional part', () => {
    expect(formatAmount(10000000n, 7)).toBe('1'); // Not 1.0000000
    expect(formatAmount(15000000n, 7)).toBe('1.5'); // Not 1.5000000
  });

  it('handles different decimal places', () => {
    expect(formatAmount(1000000n, 6)).toBe('1');
    expect(formatAmount(1000n, 3)).toBe('1');
    expect(formatAmount(100n, 2)).toBe('1');
  });

  it('handles large amounts', () => {
    expect(formatAmount(1000000000000n, 7)).toBe('100000');
  });
});

describe('lib/amount.ts - parseAmount', () => {
  it('converts token units back to raw i128 bigint', () => {
    expect(parseAmount('1', 7)).toBe(10000000n);
    expect(parseAmount('5', 7)).toBe(50000000n);
    expect(parseAmount('0', 7)).toBe(0n);
  });

  it('handles fractional inputs', () => {
    expect(parseAmount('0.5', 7)).toBe(5000000n);
    expect(parseAmount('0.0000001', 7)).toBe(1n);
  });

  it('truncates excess decimals', () => {
    expect(parseAmount('1.123456789', 7)).toBe(11234567n);
  });

  it('handles different decimal places', () => {
    expect(parseAmount('1', 6)).toBe(1000000n);
    expect(parseAmount('1', 3)).toBe(1000n);
    expect(parseAmount('1', 2)).toBe(100n);
  });

  it('returns 0 for empty or invalid input', () => {
    expect(parseAmount('', 7)).toBe(0n);
    expect(parseAmount('   ', 7)).toBe(0n);
  });
});

describe('lib/amount.ts - formatAmount/parseAmount round-trip', () => {
  it('round-trips correctly with formatAmount', () => {
    const original = 12345000n;
    const formatted = formatAmount(original, 7);
    expect(parseAmount(formatted, 7)).toBe(original);
  });

  it('round-trips various amounts', () => {
    const testCases = [1n, 100n, 1000000n, 10000000n, 123456789n, 1000000000000n];
    testCases.forEach(amount => {
      const formatted = formatAmount(amount, 7);
      expect(parseAmount(formatted, 7)).toBe(amount);
    });
  });
});

describe('lib/amount.ts - formatRate', () => {
  it('formats rate per second with per-day calculation', () => {
    // 1 token/sec = 86400 tokens/day
    expect(formatRate(10000000n, 7, 'XLM')).toBe('1 XLM/sec (86400 XLM/day)');
  });

  it('handles fractional rates', () => {
    // 0.5 token/sec = 43200 tokens/day
    expect(formatRate(5000000n, 7, 'USDC')).toBe('0.5 USDC/sec (43200 USDC/day)');
  });

  it('returns 0 format for zero rate', () => {
    expect(formatRate(0n, 7)).toBe('0');
  });

  it('works without symbol', () => {
    expect(formatRate(10000000n, 7)).toBe('1/sec (86400/day)');
  });

  it('handles very small rates', () => {
    expect(formatRate(1n, 7, 'USDC')).toBe('0.0000001 USDC/sec (0.00864 USDC/day)');
  });
});

describe('lib/amount.ts - hasValidPrecision', () => {
  it('accepts whole numbers', () => {
    expect(hasValidPrecision('100', 7)).toBe(true);
    expect(hasValidPrecision('0', 7)).toBe(true);
  });

  it('accepts values within the decimal limit', () => {
    expect(hasValidPrecision('1.234', 7)).toBe(true);
    expect(hasValidPrecision('1.1234567', 7)).toBe(true);
  });

  it('rejects values exceeding the decimal limit', () => {
    expect(hasValidPrecision('1.12345678', 7)).toBe(false);
  });

  it('respects a custom maxDecimals argument', () => {
    expect(hasValidPrecision('1.12', 2)).toBe(true);
    expect(hasValidPrecision('1.123', 2)).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(hasValidPrecision('', 7)).toBe(true);
    expect(hasValidPrecision('   ', 7)).toBe(true);
  });

  it('rejects invalid number formats', () => {
    expect(hasValidPrecision('abc', 7)).toBe(false);
    expect(hasValidPrecision('1.2.3', 7)).toBe(false);
  });
});

describe('lib/amount.ts - truncateAmount', () => {
  it('truncates to specified decimal places without rounding', () => {
    // 1.23456789 truncated to 4 decimals = 1.2345
    expect(truncateAmount(123456789n, 8, 4)).toBe('1.2345');
  });

  it('removes trailing zeros after truncation', () => {
    expect(truncateAmount(1200000n, 7, 4)).toBe('0.12');
  });

  it('returns whole number when no fractional part', () => {
    expect(truncateAmount(10000000n, 7, 4)).toBe('1');
  });

  it('handles zero amount', () => {
    expect(truncateAmount(0n, 7, 4)).toBe('0');
  });

  it('truncates to 1 decimal place', () => {
    expect(truncateAmount(123456789n, 8, 1)).toBe('1.2');
  });
});

describe('lib/amount.ts - formatCompactAmount', () => {
  it('displays whole numbers as-is', () => {
    expect(formatCompactAmount(100n, 0)).toBe('100');
    expect(formatCompactAmount(999n, 0)).toBe('999');
  });

  it('formats thousands with K', () => {
    expect(formatCompactAmount(1500n, 0)).toBe('1.5K');
    expect(formatCompactAmount(1000n, 0)).toBe('1.0K');
  });

  it('formats millions with M', () => {
    expect(formatCompactAmount(1500000n, 0)).toBe('1.5M');
    expect(formatCompactAmount(1000000n, 0)).toBe('1.0M');
  });

  it('formats billions with B', () => {
    expect(formatCompactAmount(1500000000n, 0)).toBe('1.5B');
  });

  it('respects token decimals', () => {
    // 1000 XLM (1000 * 10^7)
    expect(formatCompactAmount(10000000000n, 7)).toBe('1.0K');
  });

  it('returns 0 for zero amount', () => {
    expect(formatCompactAmount(0n, 7)).toBe('0');
  });
});

describe('lib/amount.ts - toStroops and fromStroops', () => {
  it('toStroops converts XLM to stroops (7 decimal places)', () => {
    expect(toStroops('1')).toBe(10000000n);
    expect(toStroops('0.5')).toBe(5000000n);
  });

  it('fromStroops converts stroops to XLM', () => {
    expect(fromStroops(10000000n)).toBe('1');
    expect(fromStroops(5000000n)).toBe('0.5');
  });

  it('toStroops and fromStroops round-trip', () => {
    const xlm = '123.4567890';
    const stroops = toStroops(xlm);
    const restored = fromStroops(stroops);
    expect(restored).toBe('123.456789');
  });
});

describe('lib/amount.ts - Regression tests for wizard validation', () => {
  it('hasValidPrecision rejects amounts with too many decimals for 7-decimal token', () => {
    expect(hasValidPrecision('0.12345678', 7)).toBe(false);
    expect(hasValidPrecision('100.99999999', 7)).toBe(false);
  });

  it('validates amount input as wizard uses it', () => {
    // Simulating the wizard validation flow
    const userInput = '1000.5';
    const decimals = 7;

    expect(hasValidPrecision(userInput, decimals)).toBe(true);
    const parsed = parseAmount(userInput, decimals);
    const formatted = formatAmount(parsed, decimals);
    expect(formatted).toBe(userInput);
  });

  it('formatRate provides correct daily/second breakdown for stream amounts', () => {
    // Test case: 100 USDC over 30 days
    const totalAmount = parseAmount('100', 7); // 100 * 10^7
    const totalSeconds = 30 * 24 * 3600; // 30 days in seconds
    const ratePerSecond = totalAmount / BigInt(totalSeconds);

    const formatted = formatRate(ratePerSecond, 7, 'USDC');
    expect(formatted).toContain('USDC/sec');
    expect(formatted).toContain('USDC/day');
  });
});
