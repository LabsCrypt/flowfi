"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Thin wrapper around `next-themes`' `ThemeProvider` that centralises the
 * theme configuration for the FlowFi frontend.
 *
 * ## SSR / hydration strategy (no flash-of-wrong-theme, no hydration warnings)
 *
 * Theme selection is inherently client-side: it depends on `localStorage` and,
 * for the `system` theme, on `matchMedia`. The server cannot know the user's
 * preference, so it renders `<html>` **without a theme class**; the correct
 * class is applied only on the client. Without the guard described below, two
 * problems would follow:
 *
 * 1. **Flash of wrong theme (FOUC)** — the browser would paint with the
 *    default styles first (no class means Tailwind's `dark:` variants are
 *    off, i.e. light mode), then swap to the persisted theme once the client
 *    applies it after hydration.
 * 2. **Hydration mismatch warning** — React compares the server-rendered
 *    `<html>` class list with the client DOM and warns if they differ.
 *
 * Both are prevented today, without any custom script:
 *
 * - `next-themes@0.4.x` renders its **own blocking inline `<script>`** (the
 *   library's core feature — see the installed package source,
 *   `node_modules/next-themes/dist/index.js`) that runs **before the browser
 *   paints**. It reads the value stored under `storageKey` ("flowfi-theme"),
 *   falls back to `defaultTheme` ("dark"), resolves `"system"` via
 *   `matchMedia("(prefers-color-scheme: dark)")`, and adds/removes the theme
 *   class (`light`/`dark`) on `document.documentElement`. Because the class is
 *   already correct before the first frame is drawn, there is no flash of the
 *   wrong theme.
 *
 * - The `suppressHydrationWarning` prop on `<html>` in `app/layout.tsx` tells
 *   React to skip the hydration diff check for that element, since the
 *   class-list divergence is intentional: the pre-paint script mutates the
 *   class after the server rendered the markup.
 *
 * We deliberately do **not** hand-roll a second inline script. The library's
 * built-in script already performs this exact sequence, and a duplicate would
 * race it — two sources of truth mutating the same class list is redundant and
 * brittle if the storage key or theme values ever change. Keeping the strategy
 * in one place (next-themes) is the safest option.
 *
 * ## Configuration
 *
 * - `attribute="class"` — toggles the `dark` class on `<html>`, which Tailwind
 *   uses for its `dark:` variant.
 * - `defaultTheme="dark"` — the theme the pre-paint script applies for users
 *   without a stored preference (and the initial value `useTheme()` reports
 *   before hydration).
 * - `enableSystem={true}` — allows a `"system"` theme that follows the OS
 *   `prefers-color-scheme` media query.
 * - `storageKey="flowfi-theme"` — namespaced localStorage key used by
 *   `next-themes`' pre-paint script and by `setTheme()` persistence.
 * - `disableTransitionOnChange` — prevents a brief CSS transition flash when
 *   the theme class changes.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
