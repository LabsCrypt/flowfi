/** Theme ids understood by next-themes; `system` is resolved by the library. */
export const THEMES = ["light", "dark", "high-contrast"] as const;
export type ThemeId = (typeof THEMES)[number];
export type ThemeChoice = ThemeId | "system";

export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark", "high-contrast"];
export const THEME_STORAGE_KEY = "flowfi-theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Apply a theme to <html> the same way next-themes does (used for live previews). */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  const resolved: ThemeId =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  root.classList.remove(...THEMES);
  root.classList.add(resolved);
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved === "light" ? "light" : "dark";
}
