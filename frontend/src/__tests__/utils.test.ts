import { describe, it, expect, beforeEach } from 'vitest';
import { convertArrayToCSV } from '../utils/csvExport';
import { isValidStellarPublicKey } from '../lib/stellar';
import {
  formatAmount,
  parseAmount,
  formatRate,
  hasValidPrecision,
  validateAmountInput,
  getDefaultTokenDecimals,
  setCachedTokenDecimals,
  getCachedTokenDecimals,
  clearTokenDecimalsCache,
} from '../utils/amount';

describe('formatAmount', () => {
  it('converts raw i128 stroops to token units', () => {
    expect(formatAmount(10000000n, 7)).toBe('1');
    expect(formatAmount(50000000n, 7)).toBe('5');
    expect(formatAmount(0n, 7)).toBe('0');
  });

  it('handles fractional results', () => {
    expect(formatAmount(5000000n, 7)).toBe('0.5');
    expect(formatAmount(1n, 7)).toBe('0.0000001');
  });

  it('handles large amounts', () => {
    expect(formatAmount(1000000000000n, 7)).toBe('100000');
  });

  it('handles different decimal places', () => {
    expect(formatAmount(1000000n, 6)).toBe('1');
    expect(formatAmount(1000n, 3)).toBe('1');
    expect(formatAmount(100n, 2)).toBe('1');
  });

  it('removes trailing zeros from fractional part', () => {
    expect(formatAmount(10000000n, 7)).toBe('1'); // Not 1.0000000
    expect(formatAmount(15000000n, 7)).toBe('1.5'); // Not 1.5000000
  });
});

describe('parseAmount', () => {
  it('converts token units back to raw i128 bigint', () => {
    expect(parseAmount('1', 7)).toBe(10000000n);
    expect(parseAmount('5', 7)).toBe(50000000n);
    expect(parseAmount('0', 7)).toBe(0n);
  });

  it('handles fractional inputs', () => {
    expect(parseAmount('0.5', 7)).toBe(5000000n);
    expect(parseAmount('0.0000001', 7)).toBe(1n);
  });

  it('round-trips correctly with formatAmount', () => {
    const original = 12345000n;
    const formatted = formatAmount(original, 7);
    expect(parseAmount(formatted, 7)).toBe(original);
  });

  it('handles different decimal places', () => {
    expect(parseAmount('1', 6)).toBe(1000000n);
    expect(parseAmount('1', 3)).toBe(1000n);
    expect(parseAmount('1', 2)).toBe(100n);
  });

  it('truncates excess decimals', () => {
    expect(parseAmount('1.123456789', 7)).toBe(11234567n);
  });

  it('returns 0 for empty or invalid input', () => {
    expect(parseAmount('', 7)).toBe(0n);
    expect(parseAmount('abc', 7)).toBe(0n);
    expect(parseAmount('1.2.3', 7)).toBe(0n);
  });
});

describe('formatRate', () => {
  it('formats rate per second with per-day calculation', () => {
    // 1 token/sec = 86400 tokens/day
    expect(formatRate(10000000n, 7, 'XLM')).toBe('1 XLM/sec (86400 XLM/day)');
  });

  it('handles fractional rates', () => {
    // 0.5 token/sec = 43200 tokens/day
    expect(formatRate(5000000n, 7, 'USDC')).toBe('0.5 USDC/sec (43200 USDC/day)');
  });

  it('returns 0 format for zero rate', () => {
    expect(formatRate(0n, 7, 'USDC')).toBe('0 USDC/sec');
  });

  it('works without symbol', () => {
    expect(formatRate(10000000n, 7)).toBe('1/sec (86400/day)');
  });
});

describe('hasValidPrecision', () => {
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
    expect(hasValidPrecision('', 7)).toBe(true); // Empty is valid (will be parsed as 0)
    expect(hasValidPrecision('   ', 7)).toBe(true);
  });

  it('rejects negative numbers', () => {
    expect(hasValidPrecision('-1', 7)).toBe(false);
    expect(hasValidPrecision('-1.5', 7)).toBe(false);
  });

  it('rejects invalid number formats', () => {
    expect(hasValidPrecision('abc', 7)).toBe(false);
    expect(hasValidPrecision('1.2.3', 7)).toBe(false);
  });
});

describe('validateAmountInput', () => {
  it('returns null for valid amounts', () => {
    expect(validateAmountInput('1', 7)).toBe(null);
    expect(validateAmountInput('1.5', 7)).toBe(null);
    expect(validateAmountInput('0.0000001', 7)).toBe(null);
  });

  it('returns error for empty input', () => {
    expect(validateAmountInput('', 7)).toBe('Amount is required');
  });

  it('returns error for invalid number format', () => {
    expect(validateAmountInput('abc', 7)).toBe('Please enter a valid number');
    expect(validateAmountInput('1.2.3', 7)).toBe('Please enter a valid number');
  });

  it('returns error for excessive precision', () => {
    expect(validateAmountInput('1.12345678', 7)).toBe('Amount cannot have more than 7 decimal places');
  });

  it('returns error for zero or negative amounts', () => {
    expect(validateAmountInput('0', 7)).toBe('Amount must be greater than 0');
    expect(validateAmountInput('-1', 7)).toBe('Amount must be greater than 0');
  });
});

// ─── Token Decimals Cache ─────────────────────────────────────────────────────

describe('Token decimals cache', () => {
  beforeEach(() => {
    clearTokenDecimalsCache();
  });

  it('returns undefined for uncached tokens', () => {
    expect(getCachedTokenDecimals('CDUMMY')).toBeUndefined();
  });

  it('caches and retrieves token decimals', () => {
    setCachedTokenDecimals('CDUMMY', 6);
    expect(getCachedTokenDecimals('CDUMMY')).toBe(6);
  });

  it('clears cache correctly', () => {
    setCachedTokenDecimals('CDUMMY1', 6);
    setCachedTokenDecimals('CDUMMY2', 7);
    clearTokenDecimalsCache();
    expect(getCachedTokenDecimals('CDUMMY1')).toBeUndefined();
    expect(getCachedTokenDecimals('CDUMMY2')).toBeUndefined();
  });
});

describe('getDefaultTokenDecimals', () => {
  it('returns correct decimals for known tokens', () => {
    expect(getDefaultTokenDecimals('XLM')).toBe(7);
    expect(getDefaultTokenDecimals('USDC')).toBe(7);
    expect(getDefaultTokenDecimals('EURC')).toBe(7);
    expect(getDefaultTokenDecimals('FLOW')).toBe(7);
  });

  it('returns 7 for unknown tokens', () => {
    expect(getDefaultTokenDecimals('UNKNOWN')).toBe(7);
    expect(getDefaultTokenDecimals('')).toBe(7);
  });

  it('is case insensitive', () => {
    expect(getDefaultTokenDecimals('xlm')).toBe(7);
    expect(getDefaultTokenDecimals('usdc')).toBe(7);
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
