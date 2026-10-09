"use client";

import { Contrast, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useI18n } from "@/context/i18n-provider";
import { THEME_CHOICES, isThemeChoice, type ThemeChoice } from "@/lib/themes";
import type { TranslationKey } from "@/locales";

const ICONS = { system: Monitor, light: Sun, dark: Moon, "high-contrast": Contrast } as const;
const LABEL_KEYS: Record<ThemeChoice, TranslationKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
  "high-contrast": "theme.highContrast",
};

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => setIsMounted(true));
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Prevent hydration mismatch
  if (!isMounted) {
    return (
      <div className="inline-flex h-8 w-24" aria-hidden="true" />
    );
  }

  const active: ThemeChoice = isThemeChoice(theme) ? theme : "system";

  return (
    <div role="radiogroup" aria-label={t("theme.label")} className="inline-flex items-center gap-0.5 rounded-lg border border-glass-border p-0.5">
      {THEME_CHOICES.map((choice) => {
        const Icon = ICONS[choice];
        const selected = active === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(LABEL_KEYS[choice])}
            title={t(LABEL_KEYS[choice])}
            onClick={() => setTheme(choice)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              selected ? "bg-accent text-black" : "hover:bg-white/10"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
