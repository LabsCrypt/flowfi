import { describe, it, expect } from 'vitest';
import { convertArrayToCSV } from '../utils/csvExport';
import { isValidStellarPublicKey } from '../lib/stellar';
import {
  formatAmount,
  parseAmount,
  formatRate,
  hasValidPrecision,
  toStroops,
  fromStroops,
  truncateAmount,
  formatCompactAmount,
} from '../lib/amount';

describe('formatAmount', () => {
  it('converts raw bigint amounts to token units', () => {
    expect(formatAmount(10_000_000n, 7)).toBe('1');
    expect(formatAmount(50_000_000n, 7)).toBe('5');
    expect(formatAmount(0n, 7)).toBe('0');
  });

  it('preserves fractional precision and trims trailing zeros', () => {
    expect(formatAmount(5_000_000n, 7)).toBe('0.5');
    expect(formatAmount(1n, 7)).toBe('0.0000001');
    expect(formatAmount(12_300_000n, 7)).toBe('1.23');
  });
});

describe('parseAmount', () => {
  it('converts token strings back to raw bigint amounts', () => {
    expect(parseAmount('1', 7)).toBe(10_000_000n);
    expect(parseAmount('5', 7)).toBe(50_000_000n);
    expect(parseAmount('0', 7)).toBe(0n);
  });

  it('round-trips correctly', () => {
    const original = '123.45';
    expect(parseAmount(formatAmount(parseAmount(original, 7), 7), 7)).toBe(parseAmount(original, 7));
  });

  it('pads and truncates fractional input as expected', () => {
    expect(parseAmount('1.5', 7)).toBe(15_000_000n);
    expect(parseAmount('1.12345678', 7)).toBe(parseAmount('1.1234567', 7));
    expect(parseAmount('', 7)).toBe(0n);
  });
});

describe('formatRate', () => {
  it('converts a raw per-second rate to a readable string', () => {
    expect(formatRate(10_000_000n, 7, 'USDC')).toBe('1 USDC/sec (86400 USDC/day)');
  });

  it('returns 0 for a zero rate', () => {
    expect(formatRate(0n, 7, 'XLM')).toBe('0');
  });
});

describe('hasValidPrecision', () => {
  it('accepts whole numbers and empty input', () => {
    expect(hasValidPrecision('', 7)).toBe(true);
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

  it('respects a custom decimal limit', () => {
    expect(hasValidPrecision('1.12', 2)).toBe(true);
    expect(hasValidPrecision('1.123', 2)).toBe(false);
  });
});

describe('isValidStellarPublicKey (recipient validation)', () => {
  it('accepts a valid G-prefixed Ed25519 public key', () => {
    const key = 'GDQERNIEDLE6SCKEAPO3ULKK5QQKFM3UIJMJQNBMKXPQR6HDYQTM2WO';
    expect(typeof isValidStellarPublicKey(key)).toBe('boolean');
  });

  it('rejects empty, short, and wrong-prefix values', () => {
    expect(isValidStellarPublicKey('')).toBe(false);
    expect(isValidStellarPublicKey('GABC123')).toBe(false);
    expect(isValidStellarPublicKey('SABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA')).toBe(false);
  });
});

describe('convertArrayToCSV', () => {
  it('returns empty string for null/undefined input', () => {
    expect(convertArrayToCSV(null)).toBe('');
    expect(convertArrayToCSV(undefined)).toBe('');
  });

  it('returns empty string for an empty array', () => {
    expect(convertArrayToCSV([])).toBe('');
  });

  it('produces a header row from object keys', () => {
    const csv = convertArrayToCSV([{ name: 'Alice', amount: 100 }]);
    expect(csv.split('\n')[0]).toBe('name,amount');
  });

  it('serialises each row correctly', () => {
    const rows = [
      { id: '1', value: 'hello' },
      { id: '2', value: 'world' },
    ];
    const csv = convertArrayToCSV(rows);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('1,hello');
    expect(lines[2]).toBe('2,world');
  });

  it('escapes cells that contain commas and quotes', () => {
    const csv = convertArrayToCSV([{ name: 'Doe, Jane', note: 'say "hello"', value: '5' }]);
    expect(csv).toContain('"Doe, Jane"');
    expect(csv).toContain('""hello""');
  });

  it('handles null and undefined cell values as empty strings', () => {
    const csv = convertArrayToCSV([{ a: null, b: undefined, c: 'ok' }]);
    expect(csv.split('\n')[1]).toBe(',,ok');
  });
});

describe('toStroops and fromStroops', () => {
  it('converts between display strings and stroops using 7 decimals', () => {
    expect(toStroops('1')).toBe(10_000_000n);
    expect(toStroops('0.5')).toBe(5_000_000n);
    expect(fromStroops(10_000_000n)).toBe('1');
    expect(fromStroops(42n)).toBe('0.0000042');
  });
});

describe('truncateAmount', () => {
  it('truncates without rounding', () => {
    expect(truncateAmount(12_345_678_900n, 7, 3)).toBe('1234.567');
    expect(truncateAmount(0n, 7, 3)).toBe('0');
  });
});

describe('formatCompactAmount', () => {
  it('formats large amounts with compact notation', () => {
    expect(formatCompactAmount(10_000_000_000n, 7)).toBe('1.0K');
    expect(formatCompactAmount(2_500_000_000_000n, 7)).toBe('250.0K');
  });
});
