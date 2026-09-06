"use client";

/**
 * ConfirmModal.tsx
 *
 * Reusable confirmation dialog for destructive actions throughout the app.
 * Generalises the CancelConfirmModal pattern so any destructive action
 * (template deletion, stream cancellation, etc.) can use a consistent,
 * styled confirmation instead of a native `window.confirm`.
 */

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useModalDialog } from "@/hooks/useModalDialog";

interface ConfirmModalProps {
  title: string;
  message: string;
  /** Text shown on the destructive confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Text shown on the safe cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Visual variant controls the confirm button colour. Defaults to "danger". */
  variant?: "danger" | "warning" | "info";
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

const VARIANT_CLASSES: Record<string, string> = {
  danger: "bg-red-600 hover:bg-red-500 text-white",
  warning: "bg-amber-600 hover:bg-amber-500 text-white",
  info: "bg-accent hover:brightness-110 text-white",
};

const ICON_CLASSES: Record<string, { ring: string; icon: string }> = {
  danger: { ring: "bg-red-500/15", icon: "text-red-400" },
  warning: { ring: "bg-amber-500/15", icon: "text-amber-400" },
  info: { ring: "bg-accent/15", icon: "text-accent" },
};

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  onClose,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isSubmitting });

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
    } catch {
      setIsSubmitting(false);
    }
  };

  const fallback = ICON_CLASSES.danger!;
  const iconStyle = ICON_CLASSES[variant] ?? fallback;
  const buttonClass =
    VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.danger;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="glass-card relative w-full max-w-md mx-4 rounded-2xl border border-glass-border p-8"
      >
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div
            className={`shrink-0 flex h-10 w-10 items-center justify-center rounded-full ${iconStyle.ring}`}
          >
            <svg
              className={`w-5 h-5 ${iconStyle.icon}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h2
              id="confirm-modal-title"
              className="text-xl font-bold"
            >
              {title}
            </h2>
            <p className="text-sm text-slate-400 mt-1">{message}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="ml-auto text-slate-400 hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {cancelLabel}
          </Button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting}
            className={`inline-flex items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none ${buttonClass}`}
          >
            {isSubmitting ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Processing…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
