"use client";

import { Languages } from "lucide-react";
import { useI18n } from "@/context/i18n-provider";
import { LOCALES, LOCALE_LABELS, isLocale } from "@/locales";

export function LanguageSelector({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className={`inline-flex items-center gap-1.5 ${className}`}>
      <Languages className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{t("settings.language")}</span>
      <select
        value={locale}
        onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}
        className="rounded-md border border-glass-border bg-transparent px-2 py-1 text-sm text-inherit"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} className="text-black">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
