"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

interface CopyButtonProps {
  /** Value written to the clipboard. */
  text: string;
  /** Visible label and pre-copy tooltip text. */
  label?: string;
  /** Tooltip text shown for the 2 seconds after a successful copy. */
  copiedLabel?: string;
  /** Accessible name while idle; defaults to {@link CopyButtonProps.label}. */
  ariaLabel?: string;
  /** Accessible name for the 2 seconds after a successful copy. */
  copiedAriaLabel?: string;
  /** Success toast text; forwarded to the shared clipboard helper. */
  successMessage?: string;
  /** Render the label text inline next to the icon (modal-style usage). */
  showLabel?: boolean;
  className?: string;
}

/** How long the checkmark/"Copied!" state stays visible. */
const COPIED_RESET_MS = 2000;

/**
 * Reusable copy-to-clipboard button with visual feedback (#1483).
 *
 * One component for every copy affordance in the dashboard (stream detail,
 * dashboard headers, modals): the icon transitions to a green checkmark for
 * 2 seconds, a tooltip flips from "Copy" to "Copied!", and success/error
 * toasts come from the shared {@link copyToClipboard} helper. It is a native
 * `<button>`, so keyboard focus and Enter/Space activation work without
 * extra handlers.
 */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied!",
  ariaLabel,
  copiedAriaLabel,
  successMessage,
  showLabel = false,
  className = "",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = async () => {
    const success = await copyToClipboard(text, {
      ...(successMessage ? { successMessage } : {}),
    });
    if (!success) return;

    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? (copiedAriaLabel ?? ariaLabel ?? label) : (ariaLabel ?? label)}
      className={`group relative inline-flex items-center justify-center gap-2 rounded-lg text-slate-500 transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 dark:text-slate-400 ${className}`}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-400" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {showLabel && <span>{copied ? copiedLabel : label}</span>}
      <span
        role="status"
        className={`pointer-events-none absolute -top-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-black/90 px-2 py-1 text-xs font-semibold text-white shadow-lg transition-opacity duration-150 ${
          copied
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      >
        {copied ? copiedLabel : label}
      </span>
    </button>
  );
}

export default CopyButton;
