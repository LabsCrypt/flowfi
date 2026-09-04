"use client";

import { useEffect, useRef } from "react";

const DEFAULT_MESSAGE = "You have unsaved changes. Are you sure you want to leave?";

function isInternalLink(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute("href");
  if (!href) return false;

  const trimmed = href.trim();
  // In-page anchors and non-navigation schemes are never internal navigations.
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return false;
  }
  if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.origin);
  } catch {
    return false;
  }

  // Only http(s) navigation counts as an in-app link. This also rejects
  // javascript:, data:, vbscript: and any other executable/foreign scheme.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  return url.origin === window.location.origin;
}

/**
 * Guards against losing unsaved changes while a page is mounted.
 *
 * - Registers a `beforeunload` handler (tab close / refresh / full unload).
 * - Intercepts clicks on any internal `<a>` link (navbar, footer, `next/link`,
 *   etc.) and confirms before allowing the client-side navigation.
 * - Intercepts browser back/forward navigation via `popstate` and restores the
 *   current entry when the user declines.
 */
export function useUnsavedChangesGuard(
  isDirty: boolean,
  message: string = DEFAULT_MESSAGE
): void {
  const isDirtyRef = useRef(isDirty);
  const messageRef = useRef(message);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  // Tab close / refresh / any full page unload
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Internal link navigation (navbar, footer, any <a>/next/link)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!isDirtyRef.current || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a");
      if (!anchor || !isInternalLink(anchor)) return;

      const confirmed = window.confirm(messageRef.current);
      if (!confirmed) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  // Browser back / forward navigation
  useEffect(() => {
    const handlePopState = () => {
      if (!isDirtyRef.current) return;
      const confirmed = window.confirm(messageRef.current);
      if (!confirmed) {
        history.pushState(null, "", window.location.href);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
}
