"use client";

import { useEffect, useRef } from "react";

export interface KeyboardShortcut {
  /** Value matched against `KeyboardEvent.key`, e.g. `"j"`, `"/"` or `"?"`. */
  key: string;
  handler: (event: KeyboardEvent) => void;
  /** Fire even while an input/textarea/select/contenteditable is focused. */
  allowInEditable?: boolean;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when the event target is a field the user is typing into. */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as HTMLElement;
  if (typeof element.tagName !== "string") return false;
  if (EDITABLE_TAGS.has(element.tagName.toUpperCase())) return true;
  return element.isContentEditable === true;
}

/**
 * Register global keyboard shortcuts on `window`.
 *
 * Shortcuts are ignored while the user is typing in an editable element
 * (unless a shortcut opts in via `allowInEditable`), and whenever a modifier
 * key (Cmd/Ctrl/Alt) is held so browser shortcuts keep working.
 *
 * The `shortcuts` array may be re-created on every render; the listener is
 * bound once and reads the latest handlers through a ref.
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  enabled = true,
): void {
  const shortcutsRef = useRef(shortcuts);

  useEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const editable = isEditableElement(event.target);
      for (const shortcut of shortcutsRef.current) {
        if (event.key !== shortcut.key) continue;
        if (editable && !shortcut.allowInEditable) continue;
        shortcut.handler(event);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
