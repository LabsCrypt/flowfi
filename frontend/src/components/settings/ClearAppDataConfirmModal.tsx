"use client";

import React, { useState } from "react";
import { AlertTriangle, Database, X } from "lucide-react";
import { useModalDialog } from "@/hooks/useModalDialog";

interface ClearAppDataConfirmModalProps {
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export const ClearAppDataConfirmModal: React.FC<
  ClearAppDataConfirmModalProps
> = ({ onConfirm, onClose }) => {
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
      aria-labelledby="clear-app-data-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-3xl border border-white/10 dark:border-black/10 bg-zinc-900 dark:bg-white p-6 md:p-8 shadow-2xl space-y-6 text-white dark:text-black"
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <AlertTriangle size={24} />
            </div>
            <div>
              <h2
                id="clear-app-data-modal-title"
                className="text-xl font-semibold tracking-tight"
              >
                Clear App Data?
              </h2>
              <p className="text-xs text-white/60 dark:text-black/60 mt-0.5">
                Remove local FlowFi preferences and session data
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

        <div className="space-y-4">
          <p className="text-sm opacity-80 leading-relaxed">
            This will clear FlowFis disposable local data, including your
            wallet session, preferences, saved stream templates, and the
            current create-stream draft.
          </p>

          <div className="flex items-start gap-3 rounded-xl border border-white/10 dark:border-black/10 bg-black/20 dark:bg-black/5 px-4 py-3">
            <Database
              size={18}
              className="mt-0.5 shrink-0 text-blue-400"
            />
            <p className="text-xs leading-relaxed text-white/60 dark:text-black/60">
              Encrypted vault material is not included in this clear operation.
            </p>
          </div>

          <p className="text-xs text-white/50 dark:text-black/50">
            This action also clears the same disposable data in other open
            FlowFi tabs.
          </p>
        </div>

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
            className="px-5 py-2.5 text-sm font-medium rounded-xl bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-600/20 transition-all disabled:opacity-50"
          >
            {isSubmitting ? "Clearing..." : "Clear App Data"}
          </button>
        </div>
      </div>
    </div>
  );
};
