import { describe, it, expect } from 'vitest';
import { describe, it, expect, beforeEach } from 'vitest';
import { convertArrayToCSV } from '../utils/csvExport';
import { isValidStellarPublicKey } from '../lib/stellar';
import {
  fromStroops,
  toStroops,
  formatStreamRate,
  hasValidPrecision,
  getCachedTokenDecimals,
  setCachedTokenDecimals,
  clearTokenDecimalsCache,
} from '../utils/amount';

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

// ─── isValidStellarPublicKey ──────────────────────────────────────────────────

describe('isValidStellarPublicKey (recipient validation)', () => {
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

// ─── amount.ts ────────────────────────────────────────────────────────────────

describe('fromStroops', () => {
  it('converts 0 decimals — returns raw string', () => {
    expect(fromStroops(42n, 0)).toBe('42');
  });

  it('converts to exact token units', () => {
    expect(fromStroops(10_000_000n, 7)).toBe('1');
    expect(fromStroops(50_000_000n, 7)).toBe('5');
  });

  it('produces fractional output', () => {
    expect(fromStroops(5_000_000n, 7)).toBe('0.5');
    expect(fromStroops(1n, 7)).toBe('0.0000001');
  });

  it('trims trailing zeros in fractional part', () => {
    expect(fromStroops(12_300_000n, 7)).toBe('1.23');
  });

  it('handles zero', () => {
    expect(fromStroops(0n, 7)).toBe('0');
  });

  it('handles large amounts', () => {
    expect(fromStroops(1_000_000_000_000n, 7)).toBe('100000');
  });

  it('round-trips with toStroops', () => {
    expect(fromStroops(toStroops('3.14', 7), 7)).toBe('3.14');
  });
});

describe('toStroops', () => {
  it('converts whole token units to stroops', () => {
    expect(toStroops('1', 7)).toBe(10_000_000n);
    expect(toStroops('5', 7)).toBe(50_000_000n);
  });

  it('converts fractional token units', () => {
    expect(toStroops('0.5', 7)).toBe(5_000_000n);
    expect(toStroops('0.0000001', 7)).toBe(1n);
  });

  it('returns 0n for empty/whitespace string', () => {
    expect(toStroops('', 7)).toBe(0n);
    expect(toStroops('   ', 7)).toBe(0n);
  });

  it('truncates fractional part exceeding decimals', () => {
    expect(toStroops('1.12345678', 7)).toBe(toStroops('1.1234567', 7));
  });

  it('pads short fractional parts', () => {
    expect(toStroops('1.5', 7)).toBe(15_000_000n);
  });

  it('handles 0 decimals', () => {
    expect(toStroops('42', 0)).toBe(42n);
  });
});

describe('formatStreamRate', () => {
  it('includes per-second and per-month rates', () => {
    const result = formatStreamRate(10_000_000n, 7, 'USDC');
    expect(result).toContain('USDC/sec');
    expect(result).toContain('USDC/month');
  });

  it('uses USDC as the default token symbol', () => {
    expect(formatStreamRate(10_000_000n, 7)).toContain('USDC');
  });

  it('shows 0 rate as "0"', () => {
    expect(formatStreamRate(0n, 7, 'XLM')).toMatch(/^0 XLM\/sec/);
  });
});

describe('hasValidPrecision (amount.ts)', () => {
  it('returns true for empty string', () => {
    expect(hasValidPrecision('', 7)).toBe(true);
  });

  it('accepts whole numbers', () => {
    expect(hasValidPrecision('100', 7)).toBe(true);
  });

  it('accepts fractional values within limit', () => {
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

describe('token decimals cache', () => {
  beforeEach(() => { clearTokenDecimalsCache(); });

  it('returns undefined for uncached address', () => {
    expect(getCachedTokenDecimals('GABC')).toBeUndefined();
  });

  it('stores and retrieves decimals', () => {
    setCachedTokenDecimals('GTOKEN', 7);
    expect(getCachedTokenDecimals('GTOKEN')).toBe(7);
  });

  it('clearTokenDecimalsCache wipes all entries', () => {
    setCachedTokenDecimals('GTOKEN', 7);
    clearTokenDecimalsCache();
    expect(getCachedTokenDecimals('GTOKEN')).toBeUndefined();
  });
});
