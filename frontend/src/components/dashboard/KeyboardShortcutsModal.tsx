"use client";

import { X } from "lucide-react";

export interface ShortcutReference {
  /** Keys that trigger the action, rendered as `<kbd>` chips. */
  keys: string[];
  description: string;
}

/** Single source of truth for the cheatsheet and the footer badge hint. */
export const SHORTCUT_REFERENCE: ShortcutReference[] = [
  { keys: ["/"], description: "Focus the stream search" },
  { keys: ["j"], description: "Select the next stream" },
  { keys: ["k"], description: "Select the previous stream" },
  {
    keys: ["c"],
    description: "Open the batch claim drawer (when funds are claimable)",
  },
  { keys: ["Esc"], description: "Close dialogs" },
  { keys: ["?"], description: "Show this shortcuts dialog" },
];

export function KeyboardShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-950 p-6 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-accent">
              Cheatsheet
            </p>
            <h2 className="mt-1 text-2xl font-semibold">Keyboard shortcuts</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <ul className="mt-6 space-y-3">
          {SHORTCUT_REFERENCE.map((shortcut) => (
            <li
              key={shortcut.keys.join("+")}
              className="flex items-center justify-between gap-4 border-b border-white/5 pb-3 last:border-b-0"
            >
              <span className="text-sm text-slate-300">
                {shortcut.description}
              </span>
              <span className="flex shrink-0 gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded-md border border-white/15 bg-white/5 px-2 py-1 font-mono text-xs text-slate-200"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-6 text-xs text-slate-500">
          Shortcuts are disabled while typing in a text field.
        </p>
      </div>
    </div>
  );
}
