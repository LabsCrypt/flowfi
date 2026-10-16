import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import pt from "./pt.json";
import zh from "./zh.json";
import ja from "./ja.json";

export const LOCALES = ["en", "es", "fr", "pt", "zh", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "flowfi-locale";

/** Native names shown in the language selector. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  pt: "Português",
  zh: "中文",
  ja: "日本語",
};

/** BCP 47 tags handed to Intl for number/date/currency formatting. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  pt: "pt-BR",
  zh: "zh-CN",
  ja: "ja-JP",
};

export const dictionaries: Record<Locale, Dictionary> = { en, es, fr, pt, zh, ja };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Map a browser language tag (e.g. "pt-BR", "zh-Hans") to a supported locale. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.toLowerCase().split("-")[0];
  return isLocale(base) ? base : null;
}

export function detectBrowserLocale(nav?: Pick<Navigator, "language" | "languages">): Locale {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!n) return DEFAULT_LOCALE;
  for (const tag of [...(n.languages ?? []), n.language]) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}
