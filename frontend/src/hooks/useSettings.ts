"use client";

import { useState, useEffect, useCallback } from "react";

export type Theme = "light" | "dark" | "system";
export type DisplayCurrency = "USD" | "XLM" | "USDC";
export type AmountFormat = "full" | "compact";
export type DecimalPlaces = 2 | 4 | 7;

interface Settings {
  theme: Theme;
  displayCurrency: DisplayCurrency;
  amountFormat: AmountFormat;
  decimalPlaces: DecimalPlaces;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  displayCurrency: "USD",
  amountFormat: "full",
  decimalPlaces: 7,
};

const STORAGE_KEYS = {
  theme: "flowfi-theme",
  displayCurrency: "flowfi-currency",
  amountFormat: "flowfi-amount-format",
  decimalPlaces: "flowfi-decimal-places",
};

let sharedSettings: Settings = { ...DEFAULT_SETTINGS };
let sharedIsHydrated = false;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

function loadSettingsFromStorage(): Settings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  const savedTheme = localStorage.getItem(STORAGE_KEYS.theme) as Theme | null;
  const savedCurrency = localStorage.getItem(
    STORAGE_KEYS.displayCurrency
  ) as DisplayCurrency | null;
  const savedFormat = localStorage.getItem(
    STORAGE_KEYS.amountFormat
  ) as AmountFormat | null;
  const savedDecimals = localStorage.getItem(STORAGE_KEYS.decimalPlaces);

  return {
    theme: savedTheme || DEFAULT_SETTINGS.theme,
    displayCurrency: savedCurrency || DEFAULT_SETTINGS.displayCurrency,
    amountFormat: savedFormat || DEFAULT_SETTINGS.amountFormat,
    decimalPlaces: savedDecimals
      ? (parseInt(savedDecimals, 10) as DecimalPlaces)
      : DEFAULT_SETTINGS.decimalPlaces,
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key || Object.values(STORAGE_KEYS).includes(e.key)) {
      sharedSettings = loadSettingsFromStorage();
      sharedIsHydrated = true;
      notifyListeners();
    }
  });
}

// For testing purposes
export function _resetSharedSettings() {
  sharedSettings = { ...DEFAULT_SETTINGS };
  sharedIsHydrated = false;
  listeners.clear();
}

export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(sharedSettings);
  const [isHydrated, setIsHydrated] = useState(sharedIsHydrated);

  useEffect(() => {
    const listener = () => {
      setSettingsState(sharedSettings);
      setIsHydrated(sharedIsHydrated);
    };
    listeners.add(listener);

    if (!sharedIsHydrated && typeof window !== "undefined") {
      queueMicrotask(() => {
        if (!sharedIsHydrated) {
          sharedSettings = loadSettingsFromStorage();
          sharedIsHydrated = true;
          notifyListeners();
        }
      });
    } else {
      listener();
    }

    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    sharedSettings = { ...sharedSettings, theme };
    localStorage.setItem(STORAGE_KEYS.theme, theme);
    notifyListeners();

    // Apply theme immediately
    if (theme === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", prefersDark);
    } else {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, []);

  const setDisplayCurrency = useCallback((currency: DisplayCurrency) => {
    sharedSettings = { ...sharedSettings, displayCurrency: currency };
    localStorage.setItem(STORAGE_KEYS.displayCurrency, currency);
    notifyListeners();
  }, []);

  const setAmountFormat = useCallback((format: AmountFormat) => {
    sharedSettings = { ...sharedSettings, amountFormat: format };
    localStorage.setItem(STORAGE_KEYS.amountFormat, format);
    notifyListeners();
  }, []);

  const setDecimalPlaces = useCallback((places: DecimalPlaces) => {
    sharedSettings = { ...sharedSettings, decimalPlaces: places };
    localStorage.setItem(STORAGE_KEYS.decimalPlaces, places.toString());
    notifyListeners();
  }, []);

  return {
    ...settings,
    isHydrated,
    setTheme,
    setDisplayCurrency,
    setAmountFormat,
    setDecimalPlaces,
  };
}

// Helper function to get decimal places synchronously (for non-React usage)
export function getDecimalPlaces(): DecimalPlaces {
  if (typeof window === "undefined") return 7;
  const saved = localStorage.getItem(STORAGE_KEYS.decimalPlaces);
  return saved ? (parseInt(saved, 10) as DecimalPlaces) : 7;
}

// Helper function to get theme synchronously
export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem(STORAGE_KEYS.theme) as Theme) || "dark";
}

// Apply theme immediately (useful for initial page load)
export function applyStoredTheme(): void {
  if (typeof window === "undefined") return;

  const theme = getStoredTheme();
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

// Format amount based on user's decimal places preference
export function formatAmountWithPreference(
  amount: string | number | bigint,
  tokenDecimals: number = 7
): string {
  const userDecimals = getDecimalPlaces();
  const divisor = BigInt(10 ** tokenDecimals);

  let raw: bigint;
  if (typeof amount === "bigint") {
    raw = amount;
  } else if (typeof amount === "number") {
    raw = BigInt(Math.round(amount * 10 ** tokenDecimals));
  } else {
    raw = BigInt(amount);
  }

  const integerPart = raw / divisor;
  const fractionalPart = raw % divisor;

  if (fractionalPart === 0n) {
    return integerPart.toString();
  }

  // Convert fractional part to string and pad with leading zeros
  const fractionalStr = fractionalPart
    .toString()
    .padStart(tokenDecimals, "0")
    .slice(0, userDecimals);

  // Remove trailing zeros
  const trimmedFractional = fractionalStr.replace(/0+$/, "");

  if (!trimmedFractional) return integerPart.toString();
  return `${integerPart}.${trimmedFractional}`;
}

// Get user preference for amount formatting
export function getAmountFormat(): AmountFormat {
  if (typeof window === "undefined") return "full";
  return (localStorage.getItem(STORAGE_KEYS.amountFormat) as AmountFormat) || "full";
}

// Get user preference for display currency
export function getDisplayCurrency(): DisplayCurrency {
  if (typeof window === "undefined") return "USD";
  return (
    (localStorage.getItem(STORAGE_KEYS.displayCurrency) as DisplayCurrency) || "USD"
  );
}

export { STORAGE_KEYS, DEFAULT_SETTINGS };
export default useSettings;

/**
 * Usage examples:
 *
 * In React components:
 * const { theme, decimalPlaces, setTheme } = useSettings();
 *
 * For non-React code (utils, formatters):
 * const decimals = getDecimalPlaces(); // 2, 4, or 7
 * const formatted = formatAmountWithPreference(rawAmount, 7);
 * const format = getAmountFormat(); // 'full' or 'compact'
 */
