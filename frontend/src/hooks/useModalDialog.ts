import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface UseModalDialogOptions {
  onClose: () => void;
  isCloseDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useModalDialog({
  onClose,
  isCloseDisabled = false,
  initialFocusRef,
}: UseModalDialogOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Read the latest callbacks through refs so a parent re-render with a new
  // inline onClose does not re-run the effect and steal focus.
  const onCloseRef = useRef(onClose);
  const isCloseDisabledRef = useRef(isCloseDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
    isCloseDisabledRef.current = isCloseDisabled;
  }, [onClose, isCloseDisabled]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      focusable?.[0]?.focus();
    }

    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!isCloseDisabledRef.current) {
          onCloseRef.current();
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

      if (firstElement && lastElement) {
        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }

        if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      previouslyFocusedRef.current?.focus();
    };
  }, [initialFocusRef]);

  return dialogRef;
}
