"use client";
import React, { useRef, useEffect } from "react";

interface RecipientStepProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

export const RecipientStep: React.FC<RecipientStepProps> = ({
  value,
  onChange,
  error,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          onChange={(e) => onChange(e.target.value)}
          placeholder="GABCDEFGHIJKLMNOPQRSTUVWXYZ..."
          className={`w-full px-4 py-3 rounded-lg bg-glass border ${
            error
              ? "border-red-500 focus:border-red-500 focus:ring-red-500"
              : "border-glass-border focus:border-accent focus:ring-accent"
          } focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground placeholder-slate-500`}
          aria-invalid={!!error}
          aria-describedby={error ? "recipient-error" : undefined}
        />
        {error && (
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
            {error}
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
