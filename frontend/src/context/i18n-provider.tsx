"use client";

import * as React from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  LOCALE_TAGS,
  detectBrowserLocale,
  dictionaries,
  isLocale,
  type Locale,
  type TranslationKey,
} from "@/locales";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (value: number, currency?: string) => string;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

function readStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Render the default locale on the server and first client pass so hydration
  // matches; the stored / detected locale is applied right after mount.
  const [locale, setLocaleState] = React.useState<Locale>(DEFAULT_LOCALE);

  React.useEffect(() => {
    const next = readStoredLocale() ?? detectBrowserLocale();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocaleState(next);
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* storage unavailable: preference lasts for this session only */
    }
  }, []);

  const value = React.useMemo<I18nContextValue>(() => {
    const tag = LOCALE_TAGS[locale];
    const dict = dictionaries[locale];
    return {
      locale,
      setLocale,
      t: (key, vars) => interpolate(dict[key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key, vars),
      formatNumber: (v, o) => new Intl.NumberFormat(tag, o).format(v),
      formatCurrency: (v, currency = "USD") =>
        new Intl.NumberFormat(tag, { style: "currency", currency }).format(v),
      formatDate: (v, o = { dateStyle: "medium" }) => new Intl.DateTimeFormat(tag, o).format(new Date(v)),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const FALLBACK: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, vars) => interpolate(dictionaries[DEFAULT_LOCALE][key] ?? key, vars),
  formatNumber: (v, o) => new Intl.NumberFormat(LOCALE_TAGS.en, o).format(v),
  formatCurrency: (v, c = "USD") => new Intl.NumberFormat(LOCALE_TAGS.en, { style: "currency", currency: c }).format(v),
  formatDate: (v, o = { dateStyle: "medium" }) => new Intl.DateTimeFormat(LOCALE_TAGS.en, o).format(new Date(v)),
};

/** Outside a provider (e.g. isolated component tests) fall back to English. */
export function useI18n(): I18nContextValue {
  return React.useContext(I18nContext) ?? FALLBACK;
}
