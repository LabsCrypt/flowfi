"use client";

/**
 * DisconnectConfirmModal.tsx
 *
 * Confirmation dialog before disconnecting the connected wallet.
 * Prevents accidental disconnects that could interrupt in-progress activity.
 */

import React, { useState } from "react";
import { LogOut, AlertTriangle, X } from "lucide-react";
import { useModalDialog } from "@/hooks/useModalDialog";

interface DisconnectConfirmModalProps {
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  walletAddress?: string;
}

export const DisconnectConfirmModal: React.FC<DisconnectConfirmModalProps> = ({
  onConfirm,
  onClose,
  walletAddress,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isSubmitting });

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disconnect-confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-3xl border border-white/10 dark:border-black/10 bg-zinc-900 dark:bg-white p-6 md:p-8 shadow-2xl space-y-6 text-white dark:text-black"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-red-500/10 text-red-500 border border-red-500/20">
              <AlertTriangle size={24} />
            </div>
            <div>
              <h2 id="disconnect-confirm-modal-title" className="text-xl font-semibold tracking-tight">
                Disconnect Wallet?
              </h2>
              <p className="text-xs text-white/60 dark:text-black/60 mt-0.5">
                Confirm wallet disconnection
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close"
            className="p-1 rounded-lg text-white/50 dark:text-black/50 hover:text-white dark:hover:text-black hover:bg-white/10 dark:hover:bg-black/10 transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div className="space-y-3">
          <p className="text-sm opacity-80 leading-relaxed">
            Are you sure you want to disconnect your wallet? Disconnecting will end your active session and any unsaved stream views or forms may be reset.
          </p>
          {walletAddress && (
            <div className="px-4 py-3 rounded-xl bg-black/40 dark:bg-black/5 border border-white/10 dark:border-black/10 text-xs font-mono text-white/70 dark:text-black/70 truncate">
              {walletAddress}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-5 py-2.5 text-sm font-medium rounded-xl border border-white/10 dark:border-black/10 text-white/80 dark:text-black/80 hover:bg-white/5 dark:hover:bg-black/5 transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-xl bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20 transition-all disabled:opacity-50"
          >
            <LogOut size={16} />
            {isSubmitting ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      </div>
    </div>
  );
};
