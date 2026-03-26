"use client";

/**
 * CancelConfirmModal.tsx
 *
 * Confirmation dialog before cancelling an active stream.
 * Clearly communicates the consequences (stream stops, no refund of
 * already-withdrawn funds) before the user commits.
 */

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

interface CancelConfirmModalProps {
  streamId: string;
  recipient: string;
  token: string;
  deposited: number;
  withdrawn: number;
  onConfirm: (streamId: string) => Promise<void>;
  onClose: () => void;
}

export const CancelConfirmModal: React.FC<CancelConfirmModalProps> = ({
  streamId,
  recipient,
  token,
  deposited,
  withdrawn,
  onConfirm,
  onClose,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Escape key support
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose, isSubmitting]);

  const remaining = deposited - withdrawn;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm(streamId);
    } catch {
      // Errors are handled upstream (toast in dashboard-view)
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div className="glass-card relative w-full max-w-md mx-4 rounded-2xl border border-red-500/30 p-8">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {/* Warning icon */}
          <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-red-500/15">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold">Cancel Stream?</h2>
            <p className="text-sm text-slate-400 mt-1">
              This action is permanent and cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="ml-auto text-slate-400 hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Stream summary */}
        <div className="mb-6 rounded-lg bg-white/5 border border-glass-border divide-y divide-glass-border text-sm">
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Stream</span>
            <code className="text-accent font-mono text-xs">{streamId}</code>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Recipient</span>
            <code className="font-mono text-xs text-foreground">{recipient}</code>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Already withdrawn</span>
            <span className="font-semibold text-foreground">{withdrawn} {token}</span>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Remaining in stream</span>
            <span className="font-semibold text-accent">{remaining} {token}</span>
          </div>
        </div>

        {/* Consequence note */}
        <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300">
          <strong className="text-red-400">What happens:</strong> The stream stops immediately.
          The recipient keeps any already-withdrawn funds. Remaining funds
          ({remaining} {token}) stay locked in the contract until the recipient withdraws
          or the admin resolves them.
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Keep Stream
          </Button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting}
            className="inline-flex items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Cancelling…
              </>
            ) : (
              "Yes, Cancel Stream"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
