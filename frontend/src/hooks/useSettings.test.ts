import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useSettings,
  STORAGE_KEYS,
  formatAmountWithPreference,
  DEFAULT_SETTINGS
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

      expect(result.current.theme).toBe(DEFAULT_SETTINGS.theme);
      expect(result.current.displayCurrency).toBe(DEFAULT_SETTINGS.displayCurrency);
      expect(result.current.amountFormat).toBe(DEFAULT_SETTINGS.amountFormat);
      expect(result.current.decimalPlaces).toBe(DEFAULT_SETTINGS.decimalPlaces);
    });

    it('hydrates settings from pre-seeded localStorage values', async () => {
      localStorage.setItem(STORAGE_KEYS.theme, 'light');
      localStorage.setItem(STORAGE_KEYS.displayCurrency, 'XLM');
      localStorage.setItem(STORAGE_KEYS.amountFormat, 'compact');
      localStorage.setItem(STORAGE_KEYS.decimalPlaces, '4');

      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.theme).toBe('light');
      expect(result.current.displayCurrency).toBe('XLM');
      expect(result.current.amountFormat).toBe('compact');
      expect(result.current.decimalPlaces).toBe(4);
    });

    it('updates state and localStorage when setTheme is called', async () => {
      const { result } = renderHook(() => useSettings());
      
      await waitFor(() => expect(result.current.isHydrated).toBe(true));

      act(() => {
        result.current.setTheme('light');
      });

      expect(result.current.theme).toBe('light');
      expect(localStorage.getItem(STORAGE_KEYS.theme)).toBe('light');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
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
});
