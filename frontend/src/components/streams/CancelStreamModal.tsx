"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface CancelStreamModalProps {
  isOpen: boolean;
  isCancelling: boolean;
  streamId: string;
  onClose: () => void;
  onConfirm: () => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function CancelStreamModal({
  isOpen,
  isCancelling,
  streamId,
  onClose,
  onConfirm,
}: CancelStreamModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!isCancelling) {
          onClose();
        }
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );

      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      }

      if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      previouslyFocusedRef.current?.focus();
    };
  }, [isCancelling, isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-stream-title"
      aria-describedby="cancel-stream-description"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isCancelling) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-red-500/30 bg-background p-6 shadow-2xl"
      >
        <div className="flex items-start gap-4">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400"
          >
            <AlertTriangle size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="cancel-stream-title" className="m-0 text-xl font-bold">
              Cancel Stream?
            </h2>
            <p
              id="cancel-stream-description"
              className="mt-2 text-sm leading-6 text-slate-400"
            >
              This submits an irreversible on-chain cancellation for stream #{streamId}.
              The stream will stop, and this action cannot be undone.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close cancel stream confirmation"
            className="rounded-full p-1 text-slate-400 transition-colors hover:text-foreground disabled:opacity-50"
            disabled={isCancelling}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className="mt-5 rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm leading-6 text-red-200">
          Only confirm if you are certain. The backend will submit the cancellation
          transaction and the stream status will update after the request succeeds.
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" disabled={isCancelling} onClick={onClose}>
            Go Back
          </Button>
          <Button
            type="button"
            disabled={isCancelling}
            onClick={onConfirm}
            style={{ background: "#dc2626", color: "#fff" }}
          >
            {isCancelling ? "Cancelling..." : "Confirm Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
