"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Thin wrapper around `next-themes`' `ThemeProvider` that centralises theme
 * configuration for the FlowFi frontend.
 *
 * ## SSR / Hydration Strategy
 *
 * Theme selection is inherently a client-side concern (it depends on
 * `localStorage` and/or `matchMedia`). The server cannot know which theme the
 * user prefers, so it always renders a default (`dark`) theme class. This
 * creates two problems:
 *
 * 1. **Flash of wrong theme (FART).** If the user chose "light" previously,
 *    the browser paints the dark theme first, then swaps to light when
 *    React hydrates — an unpleasant flicker.
 *
 * 2. **Hydration mismatch warning.** When React hydrates the `<html>` element
 *    and sees that the client DOM has a `dark` class the server did not
 *    produce, it logs a console warning.
 *
 * We solve both problems with a two-part approach inside `layout.tsx`:
 *
 * - **Blocking inline `<script>` in `<head>`** — reads `flowfi-theme` from
 *   localStorage and synchronously adds/removes the `dark` class on
 *   `<html>` **before the first paint**. No flicker occurs because the
 *   correct class is present from the very first rendered frame.
 *
 * - **`suppressHydrationWarning` on `<html>`** — tells React to skip the
 *   hydration-difference check for the `<html>` element because we
 *   intentionally mutate its class list before hydration.
 *
 * After hydration, this `ThemeProvider` (via `next-themes`) takes over theme
 * management, reacting to `useTheme()` calls and persisting changes to the
 * same `flowfi-theme` localStorage key.
 *
 * ## Configuration
 *
 * - `attribute="class"` — toggles a `dark` class on `<html>`, which Tailwind
 *   uses for its `dark:` variant.
 * - `defaultTheme="dark"` — what the server (and users without any stored
 *   preference) will see.
 * - `enableSystem={true}` — when theme is set to `"system"`, the provider
 *   follows the OS-level `prefers-color-scheme` media query.
 * - `storageKey="flowfi-theme"` — namespaced localStorage key to avoid
 *   collisions with other apps on the same origin.
 * - `disableTransitionOnChange` — prevents a brief CSS transition when the
 *   theme class changes, making the switch feel instant.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
