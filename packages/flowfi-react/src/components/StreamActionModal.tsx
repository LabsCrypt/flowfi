'use client';

import type { ReactNode } from 'react';

export interface StreamActionModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  isBusy?: boolean;
  error?: string | null;
  children?: ReactNode;
}

export function StreamActionModal({
  open,
  title,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  isBusy = false,
  error,
  children,
}: StreamActionModalProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="stream-action-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
        <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{children}</div>

        {error ? (
          <p role="alert" data-testid="modal-error" className="mt-3 text-sm text-rose-600">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="modal-cancel"
            className="h-9 rounded-lg border border-slate-300 px-4 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={isBusy}
            data-testid="modal-confirm"
            className="h-9 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBusy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
