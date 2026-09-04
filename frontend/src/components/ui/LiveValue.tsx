"use client";

import { useEffect, useRef, useState } from "react";

interface LiveValueProps {
  /**
   * Text to announce. Typically the same formatted value the visible ticker
   * renders (e.g. "1,234.5 USDC").
   */
  value: string;
  /** Minimum interval in ms between announcements while the value is ticking. */
  cadenceMs?: number;
  /** Optional label prepended to the announcement, e.g. "Claimable amount". */
  prefix?: string;
}

/**
 * #1198 — Screen-reader live region for values that tick continuously.
 *
 * Continuously mutating text inside an `aria-live` region (or worse, on every
 * `requestAnimationFrame`) floods assistive technology with announcements. This
 * component keeps the region visually hidden and syncs its text from the latest
 * rendered value at most once every `cadenceMs`, announcing on user query
 * rather than per frame.
 *
 * Note: the visible ticking counter is left as normal document text so users
 * navigating with a virtual cursor read the current value directly; this live
 * region supplements it with throttled announcements.
 */
export function LiveValue({ value, cadenceMs = 1000, prefix }: LiveValueProps) {
  const valueRef = useRef(value);
  const [text, setText] = useState(() => value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const latest = valueRef.current;
      setText((prev) => (prev === latest ? prev : latest));
    }, cadenceMs);
    return () => window.clearInterval(id);
  }, [cadenceMs]);

  if (!text) return null;

  return (
    <span aria-live="polite" aria-atomic="true" className="sr-only">
      {prefix ? `${prefix} ${text}` : text}
    </span>
  );
}