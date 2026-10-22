import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useSettings,
  STORAGE_KEYS,
  formatAmountWithPreference,
  getDecimalPlaces,
  getAmountFormat,
  getDisplayCurrency,
  DEFAULT_SETTINGS,
  _resetSharedSettings
} from './useSettings';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    })
  };
})();

vi.stubGlobal('localStorage', localStorageMock);

describe('useSettings and formatAmountWithPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    _resetSharedSettings();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('useSettings hook', () => {
    it('initializes with default settings if localStorage is empty', async () => {
      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.displayCurrency).toBe(DEFAULT_SETTINGS.displayCurrency);
      expect(result.current.amountFormat).toBe(DEFAULT_SETTINGS.amountFormat);
      expect(result.current.decimalPlaces).toBe(DEFAULT_SETTINGS.decimalPlaces);
    });

    it('hydrates settings from pre-seeded localStorage values', async () => {
      localStorage.setItem(STORAGE_KEYS.displayCurrency, 'XLM');
      localStorage.setItem(STORAGE_KEYS.amountFormat, 'compact');
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4');

      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.displayCurrency).toBe('XLM');
      expect(result.current.amountFormat).toBe('compact');
      expect(result.current.decimalPlaces).toBe(4);
    });

    it('updates state and localStorage when setDecimalPlaces is called', async () => {
      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      act(() => {
        result.current.setDecimalPlaces(2);
      });

      expect(result.current.decimalPlaces).toBe(2);
      expect(localStorage.getItem(STORAGE_KEYS.decimalPlaces)).toBe('2');
    });

    it('updates state and localStorage when setDisplayCurrency is called', async () => {
      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      act(() => {
        result.current.setDisplayCurrency('USDC');
      });

      expect(result.current.displayCurrency).toBe('USDC');
      expect(localStorage.getItem(STORAGE_KEYS.displayCurrency)).toBe('USDC');
    });

    it('updates state and localStorage when setAmountFormat is called', async () => {
      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      act(() => {
        result.current.setAmountFormat('compact');
      });

      expect(result.current.amountFormat).toBe('compact');
      expect(localStorage.getItem(STORAGE_KEYS.amountFormat)).toBe('compact');
    });

    it('syncs state across multiple consumers without remount', async () => {
      const { result: consumerA } = renderHook(() => useSettings());
      const { result: consumerB } = renderHook(() => useSettings());
      
      await waitFor(() => {
        expect(consumerA.current.isHydrated).toBe(true);
        expect(consumerB.current.isHydrated).toBe(true);
      });

      act(() => {
        consumerA.current.setDecimalPlaces(2);
      });

      expect(consumerA.current.decimalPlaces).toBe(2);
      expect(consumerB.current.decimalPlaces).toBe(2);
    });

    it('syncs state across tabs using storage event', async () => {
      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      act(() => {
        // Simulate other tab changing local storage
        localStorage.setItem(STORAGE_KEYS.displayCurrency, 'EUR');
        
        // Dispatch storage event
        const event = new StorageEvent('storage', {
          key: STORAGE_KEYS.displayCurrency,
          newValue: 'EUR'
        });
        window.dispatchEvent(event);
      });

      expect(result.current.displayCurrency).toBe('EUR');
    });
  });

  describe('formatAmountWithPreference', () => {
    it('truncates to 2 decimals and trims trailing zeros', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '2');
      
      expect(formatAmountWithPreference(15000000n)).toBe('1.5');
      expect(formatAmountWithPreference(10000000n)).toBe('1');
      expect(formatAmountWithPreference(15678900n)).toBe('1.56');
    });

    it('truncates to 4 decimals and trims trailing zeros', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4');
      
      expect(formatAmountWithPreference(15000000n)).toBe('1.5');
      expect(formatAmountWithPreference(15670000n)).toBe('1.567');
      expect(formatAmountWithPreference(15678900n)).toBe('1.5678');
    });

    it('truncates to 7 decimals and trims trailing zeros', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '7');
      
      expect(formatAmountWithPreference(15000000n)).toBe('1.5');
      expect(formatAmountWithPreference(15678900n)).toBe('1.56789');
      expect(formatAmountWithPreference(15678901n)).toBe('1.5678901');
    });

    it('handles bigint inputs correctly', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4');
      expect(formatAmountWithPreference(1000000000n)).toBe('100');
      expect(formatAmountWithPreference(1001234567n)).toBe('100.1234');
    });

    it('handles number inputs correctly', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4');
      expect(formatAmountWithPreference(100.1234)).toBe('100.1234');
      expect(formatAmountWithPreference(100.1234567)).toBe('100.1234');
    });

    it('handles string inputs correctly', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4');
      // string representing 100.1234 * 10^7 = 1001234000
      expect(formatAmountWithPreference('1001234000')).toBe('100.1234');
    });
  });

  // ─── Invalid decimal settings fallback (#1784) ─────────────────────────────
  //
  // Documented behavior: a missing/empty stored value falls back to the
  // default of 7. Any other stored string is parsed with
  // `parseInt(value, 10)`, which truncates to the leading integer (or yields
  // NaN for values with no leading integer). `formatAmountWithPreference`
  // then formats with however many decimal places that produces, clamped by
  // the amount of fractional digits that actually exist — it must never
  // throw, whatever was stored.

  describe('invalid decimal settings fallback (#1784)', () => {
    it('uses the documented default of 7 when the stored value is missing or empty', () => {
      expect(getDecimalPlaces()).toBe(7);

      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '');
      expect(getDecimalPlaces()).toBe(7);
      expect(formatAmountWithPreference(15678901n)).toBe('1.5678901');
    });

    it('accepts every supported decimal value (2, 4 and 7)', () => {
      for (const value of [2, 4, 7] as const) {
        localStorage.setItem(STORAGE_KEYS.decimalPlaces, String(value));
        expect(getDecimalPlaces()).toBe(value);
      }

      // Boundary values format to exactly the requested precision.
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '2');
      expect(formatAmountWithPreference(15678901n)).toBe('1.56');
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '7');
      expect(formatAmountWithPreference(15678901n)).toBe('1.5678901');
    });

    it('truncates fractional stored values to their integer prefix', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4.9');
      expect(getDecimalPlaces()).toBe(4);

      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '2.7');
      expect(getDecimalPlaces()).toBe(2);
    });

    it('ignores leading zeros and surrounding whitespace', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '004');
      expect(getDecimalPlaces()).toBe(4);

      localStorage.setItem(STORAGE_KEYS.decimalPlaces, ' 7 ');
      expect(getDecimalPlaces()).toBe(7);
    });

    it('keeps out-of-range values parseable but never formats beyond the token precision', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '12');
      expect(getDecimalPlaces()).toBe(12);
      // Only 7 fractional digits exist on-chain, so extra digits are
      // unreachable and formatting matches the maximum supported value.
      expect(formatAmountWithPreference(15678901n)).toBe('1.5678901');

      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '100');
      expect(getDecimalPlaces()).toBe(100);
      expect(formatAmountWithPreference(15678901n)).toBe('1.5678901');
    });

    it('does not throw for negative values (they trim fractional digits from the right)', () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '-2');
      expect(getDecimalPlaces()).toBe(-2);
      // slice(0, -2) on '5678901' keeps the first five digits.
      expect(formatAmountWithPreference(15678901n)).toBe('1.56789');
    });

    it('falls back to integer-only formatting for malformed values without throwing', () => {
      for (const malformed of ['abc', 'seven', 'NaN', '—']) {
        localStorage.setItem(STORAGE_KEYS.decimalPlaces, malformed);

        const decimals = getDecimalPlaces();
        expect(Number.isNaN(decimals)).toBe(true);
        expect(() => formatAmountWithPreference(15678901n)).not.toThrow();
        // No fractional digits survive a NaN slice bound.
        expect(formatAmountWithPreference(15678901n)).toBe('1');
      }
    });

    it('hydrates the hook with malformed decimals without throwing', async () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, 'abc');

      const { result } = renderHook(() => useSettings());

      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      expect(Number.isNaN(result.current.decimalPlaces)).toBe(true);
      // The remaining settings still hydrate with their documented defaults.
      expect(result.current.displayCurrency).toBe(DEFAULT_SETTINGS.displayCurrency);
      expect(result.current.amountFormat).toBe(DEFAULT_SETTINGS.amountFormat);
    });

    it('hydrates the hook with an out-of-range value as-is', async () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '9');

      const { result } = renderHook(() => useSettings());

      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      expect(result.current.decimalPlaces).toBe(9);
    });

    it('applies a valid value written after invalid ones (recovery)', async () => {
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, 'garbage');

      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.isHydrated).toBe(true));
      expect(Number.isNaN(result.current.decimalPlaces)).toBe(true);

      act(() => {
        result.current.setDecimalPlaces(4);
      });

      expect(result.current.decimalPlaces).toBe(4);
      expect(getDecimalPlaces()).toBe(4);
      expect(formatAmountWithPreference(15678901n)).toBe('1.5678');
    });

    it('falls back to defaults for empty currency and format values', () => {
      expect(getDisplayCurrency()).toBe('USD');
      expect(getAmountFormat()).toBe('full');

      localStorage.setItem(STORAGE_KEYS.displayCurrency, '');
      localStorage.setItem(STORAGE_KEYS.amountFormat, '');

      expect(getDisplayCurrency()).toBe('USD');
      expect(getAmountFormat()).toBe('full');
    });
  });
});
