import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { I18nProvider, useI18n, interpolate } from "@/context/i18n-provider";
import { LanguageSelector } from "@/components/LanguageSelector";
import { LOCALES, LOCALE_STORAGE_KEY, dictionaries, detectBrowserLocale, matchLocale } from "@/locales";

function Probe() {
  const { t, formatNumber, formatDate, locale } = useI18n();
  return (
    <div>
      <span data-testid="home">{t("nav.home")}</span>
      <span data-testid="num">{formatNumber(1234567.5)}</span>
      <span data-testid="date">{formatDate(Date.UTC(2024, 0, 15), { dateStyle: "long", timeZone: "UTC" })}</span>
      <span data-testid="locale">{locale}</span>
    </div>
  );
}

describe("locales", () => {
  it("every locale defines exactly the English keys with non-empty values", () => {
    const keys = Object.keys(dictionaries.en).sort();
    for (const l of LOCALES) {
      expect(Object.keys(dictionaries[l]).sort(), l).toEqual(keys);
      for (const v of Object.values(dictionaries[l])) expect(v.trim()).not.toBe("");
    }
  });

  it("keeps interpolation placeholders consistent across locales", () => {
    for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      const ph = (dictionaries.en[key].match(/\{\w+\}/g) ?? []).sort();
      for (const l of LOCALES) expect((dictionaries[l][key].match(/\{\w+\}/g) ?? []).sort(), `${l}:${key}`).toEqual(ph);
    }
  });

  it("matches browser language tags to supported locales", () => {
    expect(matchLocale("pt-BR")).toBe("pt");
    expect(matchLocale("zh-Hans-CN")).toBe("zh");
    expect(matchLocale("de")).toBeNull();
    expect(matchLocale(null)).toBeNull();
    expect(detectBrowserLocale({ language: "de", languages: ["de", "fr-CA"] })).toBe("fr");
    expect(detectBrowserLocale({ language: "de", languages: ["de"] })).toBe("en");
  });

  it("interpolates variables and leaves unknown ones", () => {
    expect(interpolate("{count} mins", { count: 5 })).toBe("5 mins");
    expect(interpolate("{a}{b}", { a: "x" })).toBe("x{b}");
    expect(interpolate("plain")).toBe("plain");
  });
});

describe("I18nProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "";
  });

  it("uses the browser language when nothing is stored", async () => {
    Object.defineProperty(window.navigator, "languages", { value: ["es-MX"], configurable: true });
    Object.defineProperty(window.navigator, "language", { value: "es-MX", configurable: true });
    await act(async () => {
      render(<I18nProvider><Probe /></I18nProvider>);
    });
    expect(screen.getByTestId("locale").textContent).toBe("es");
    expect(screen.getByTestId("home").textContent).toBe("Inicio");
    expect(document.documentElement.lang).toBe("es");
  });

  it("prefers the stored locale, persists changes and localizes formatting", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    await act(async () => {
      render(<I18nProvider><Probe /><LanguageSelector /></I18nProvider>);
    });
    expect(screen.getByTestId("home").textContent).toBe("Accueil");
    expect(screen.getByTestId("num").textContent).toMatch(/1\D234\D567,5/);
    expect(screen.getByTestId("date").textContent).toContain("janvier");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ja" } });
    expect(screen.getByTestId("home").textContent).toBe("ホーム");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ja");
  });

  it("ignores an invalid stored locale", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "xx");
    Object.defineProperty(window.navigator, "languages", { value: ["en-US"], configurable: true });
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    await act(async () => {
      render(<I18nProvider><Probe /></I18nProvider>);
    });
    expect(screen.getByTestId("locale").textContent).toBe("en");
  });

  it("falls back to English outside a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("home").textContent).toBe("Home");
  });
});
