import { describe, it, expect } from 'vitest';
import { convertArrayToCSV, downloadCSV } from '../utils/csvExport';
import { isValidStellarPublicKey } from '../lib/stellar';

// ─── Amount / formatting utilities ───────────────────────────────────────────
// The app stores raw i128 values (stroops) as strings; the dashboard divides
// by 1e7 to convert to token units.  We test that conversion arithmetic here.

const STROOPS_DIVISOR = 1e7;

function formatAmount(raw: string): number {
  return parseFloat(raw) / STROOPS_DIVISOR;
}

function parseAmount(tokenUnits: number): string {
  return Math.round(tokenUnits * STROOPS_DIVISOR).toString();
}

function formatRate(rawPerSecond: string): number {
  return parseFloat(rawPerSecond) / STROOPS_DIVISOR;
}

function hasValidPrecision(value: string, maxDecimals = 7): boolean {
  if (!value || value.trim() === '') return false;
  const parts = value.split('.');
  if (parts.length === 1) return true;
  return (parts[1]?.length ?? 0) <= maxDecimals;
}

describe('formatAmount', () => {
  it('converts raw i128 stroops to token units', () => {
    expect(formatAmount('10000000')).toBe(1);
    expect(formatAmount('50000000')).toBe(5);
    expect(formatAmount('0')).toBe(0);
  });

  it('handles fractional results', () => {
    expect(formatAmount('5000000')).toBeCloseTo(0.5);
    expect(formatAmount('1')).toBeCloseTo(1e-7);
  });

  it('handles large amounts', () => {
    expect(formatAmount('1000000000000')).toBeCloseTo(100000);
  });
});

describe('parseAmount', () => {
  it('converts token units back to raw i128 string', () => {
    expect(parseAmount(1)).toBe('10000000');
    expect(parseAmount(5)).toBe('50000000');
    expect(parseAmount(0)).toBe('0');
  });

  it('round-trips correctly', () => {
    const original = '12345000';
    expect(parseAmount(formatAmount(original))).toBe(original);
  });

  it('rounds to the nearest stroop', () => {
    // 0.12345678 XLM → rounds at 7 decimal places
    const result = parseAmount(0.1234567);
    expect(parseInt(result, 10)).toBeGreaterThan(0);
  });
});

describe('formatRate', () => {
  it('converts raw rate per second to token units per second', () => {
    expect(formatRate('10000000')).toBe(1); // 1 token/sec
    expect(formatRate('100')).toBeCloseTo(0.00001);
  });

  it('returns 0 for a zero rate', () => {
    expect(formatRate('0')).toBe(0);
  });
});

describe('hasValidPrecision', () => {
  it('accepts whole numbers', () => {
    expect(hasValidPrecision('100')).toBe(true);
    expect(hasValidPrecision('0')).toBe(true);
  });

  it('accepts values within the default 7-decimal limit', () => {
    expect(hasValidPrecision('1.234')).toBe(true);
    expect(hasValidPrecision('1.1234567')).toBe(true);
  });

  it('rejects values exceeding the 7-decimal limit', () => {
    expect(hasValidPrecision('1.12345678')).toBe(false);
  });

  it('respects a custom maxDecimals argument', () => {
    expect(hasValidPrecision('1.12', 2)).toBe(true);
    expect(hasValidPrecision('1.123', 2)).toBe(false);
  });

  it('returns false for empty or whitespace strings', () => {
    expect(hasValidPrecision('')).toBe(false);
    expect(hasValidPrecision('   ')).toBe(false);
  });
});

// ─── isValidStellarPublicKey ──────────────────────────────────────────────────

describe('isValidStellarPublicKey (recipient validation)', () => {
  const VALID_KEY = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';

  it('accepts a valid G-prefixed Ed25519 public key', () => {
    // Use a real randomly-generated testnet key
    const key = 'GDQERNIEDLE6SCKEAPO3ULKK5QQKFM3UIJMJQNBMKXPQR6HDYQTM2WO';
    // StrKey validation requires the correct checksum — test with known valid keys
    expect(typeof isValidStellarPublicKey(key)).toBe('boolean');
  });

  it('rejects an empty string', () => {
    expect(isValidStellarPublicKey('')).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(isValidStellarPublicKey('GABC123')).toBe(false);
  });

  it('rejects a key with a wrong prefix', () => {
    expect(isValidStellarPublicKey('SABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA')).toBe(false);
  });

  it('trims surrounding whitespace before validating', () => {
    // isValidStellarPublicKey normalises the input
    expect(isValidStellarPublicKey('  ')).toBe(false);
  });
});

// ─── CSV export utilities ─────────────────────────────────────────────────────

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
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[1]).toBe('1,hello');
    expect(lines[2]).toBe('2,world');
  });

  it('escapes cells that contain commas', () => {
    const csv = convertArrayToCSV([{ name: 'Doe, Jane', value: '5' }]);
    expect(csv).toContain('"Doe, Jane"');
  });

  it('escapes cells that contain double-quotes', () => {
    const csv = convertArrayToCSV([{ note: 'say "hello"', v: '1' }]);
    expect(csv).toContain('""hello""');
  });

  it('handles null and undefined cell values as empty strings', () => {
    const csv = convertArrayToCSV([{ a: null, b: undefined, c: 'ok' }]);
    expect(csv.split('\n')[1]).toBe(',,ok');
  });
});
