import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertArrayToCSV, downloadCSV, escapeCsvCell } from './csvExport';

describe('escapeCsvCell', () => {
  it('returns empty string for null', () => {
    expect(escapeCsvCell(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('returns plain strings unchanged', () => {
    expect(escapeCsvCell('hello')).toBe('hello');
  });

  it('quotes values containing commas', () => {
    expect(escapeCsvCell('hello,world')).toBe('"hello,world"');
  });

  it('quotes values containing newlines', () => {
    expect(escapeCsvCell('hello\nworld')).toBe('"hello\nworld"');
  });

  it('doubles quotes inside values', () => {
    expect(escapeCsvCell('She said "Hi"')).toBe('"She said ""Hi"""');
  });

  it('formats Date values via toLocaleString', () => {
    const original = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function () {
      return '2026-06-01 12:00:00';
    };

    try {
      expect(escapeCsvCell(new Date('2026-06-01T12:00:00Z'))).toBe('2026-06-01 12:00:00');
    } finally {
      Date.prototype.toLocaleString = original;
    }
  });
});

describe('convertArrayToCSV', () => {
  it('returns an empty string for an empty array', () => {
    expect(convertArrayToCSV([])).toBe('');
  });

  it('serializes a single row correctly', () => {
    const rows = [{ name: 'Alice', amount: 10 }];
    expect(convertArrayToCSV(rows)).toBe('name,amount\nAlice,10');
  });

  it('serializes multiple rows with mixed values', () => {
    const rows = [
      { id: 1, value: 'hello,world' },
      { id: 2, value: 'line\nbreak' },
      { id: 3, value: 'quote"test' },
    ];

    expect(convertArrayToCSV(rows)).toBe(
      'id,value\n1,"hello,world"\n2,"line\nbreak"\n3,"quote""test"'
    );
  });

  it('preserves header order from the first row', () => {
    const rows = [
      { b: 1, a: 'first' },
      { b: 2, a: 'second' },
    ];

    expect(convertArrayToCSV(rows)).toBe('b,a\n1,first\n2,second');
  });
});

describe('downloadCSV', () => {
  let originalURL: typeof URL;

  beforeEach(() => {
    originalURL = globalThis.URL;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: originalURL,
    });
  });

  it('creates a Blob and triggers a download', () => {
    const createObjectURL = vi.fn(() => 'blob://test-url');
    const revokeObjectURL = vi.fn();

    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      writable: true,
      value: {
        ...globalThis.URL,
        createObjectURL,
        revokeObjectURL,
      } as unknown as typeof URL,
    });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadCSV([{ foo: 'bar' }], 'test.csv');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob://test-url');
    expect(document.querySelector('a[download="test.csv"]')).toBeNull();
  });
});
