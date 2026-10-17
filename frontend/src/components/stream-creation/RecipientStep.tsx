"use client";
import React, { useRef, useEffect, useState } from "react";
import { validateRecipient } from "@/lib/stream-validation";

interface RecipientStepProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

const STELLAR_PUBLIC_KEY_LENGTH = 56;

export const RecipientStep: React.FC<RecipientStepProps> = ({
  value,
  onChange,
  error,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = value.trim();

  // Real-time feedback: validate once the user has committed the field
  // (blur / paste) or entered a full-length key, so partial typing does not
  // flash errors while still catching bad checksums immediately.
  const liveError =
    touched || trimmed.length >= STELLAR_PUBLIC_KEY_LENGTH
      ? validateRecipient(value)
      : null;

  // The wizard-provided error (set on step validation) takes precedence.
  const displayError = error ?? liveError;

  const handleChange = (next: string) => {
    setTouched(true);
    onChange(next);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted) return;

    // Replace the current selection with the trimmed clipboard text so
    // whitespace-padded keys copied from wallets/explorers just work.
    e.preventDefault();
    const target = e.currentTarget;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next =
      target.value.slice(0, start) + pasted.trim() + target.value.slice(end);
    setTouched(true);
    onChange(next);
  };

  const handleBlur = () => {
    setTouched(true);
    const cleaned = value.trim();
    if (cleaned !== value) {
      onChange(cleaned);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold mb-2">Recipient Address</h3>
        <p className="text-sm text-slate-400 mb-4">
          Enter the Stellar public key (G...) of the recipient who will receive
          the payment stream.
        </p>
      </div>

      <div>
        <label
          htmlFor="recipient"
          className="block text-sm font-medium mb-2 text-foreground"
        >
          Stellar Public Key
        </label>
        <input
          ref={inputRef}
          id="recipient"
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={handlePaste}
          onBlur={handleBlur}
          placeholder="GABCDEFGHIJKLMNOPQRSTUVWXYZ..."
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className={`w-full px-4 py-3 rounded-lg bg-glass border ${
            displayError
              ? "border-red-500 focus:border-red-500 focus:ring-red-500"
              : "border-glass-border focus:border-accent focus:ring-accent"
          } focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground placeholder-slate-500`}
          aria-invalid={!!displayError}
          aria-describedby={displayError ? "recipient-error" : undefined}
        />
        {displayError && (
          <p
            id="recipient-error"
            className="mt-2 text-sm text-red-400 flex items-center gap-1"
            role="alert"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            {displayError}
          </p>
        )}
      </div>

      <div className="mt-6 p-4 rounded-lg bg-accent/5 border border-accent/20">
        <p className="text-sm text-slate-300">
          <strong className="text-accent">Tip:</strong> You can copy the public
          key from the recipient&apos;s wallet or Stellar account explorer.
        </p>
      </div>
    </div>
  );
};
