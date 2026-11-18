"use client";
import React, { useRef, useEffect } from "react";
import { getSpendableBalance, XLM_BASE_RESERVE } from "@/lib/stream-validation";

interface AmountStepProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  token?: string;
  availableBalance?: string | null;
  isBalanceLoading?: boolean;
  balanceError?: string | null;
  onSetMax?: () => void;
}

export const AmountStep: React.FC<AmountStepProps> = ({
  value,
  onChange,
  error,
  token,
  availableBalance,
  isBalanceLoading = false,
  balanceError,
  onSetMax,
}) => {
  const handleAmountChange = (newValue: string) => {
    onChange(newValue);
  };
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isXlm = (token ?? "").toUpperCase() === "XLM";
  const spendable = getSpendableBalance(availableBalance, token);
  const isSpendableKnown = spendable !== null;
  const canSetMax = isSpendableKnown && spendable > 0 && !isBalanceLoading;

  // Live over-balance detection so the error appears before the user tries
  // to advance / submit, not just after the step is validated.
  const parsedValue = parseFloat(value);
  const isOverBalance =
    !error &&
    isSpendableKnown &&
    value.trim() !== "" &&
    !isNaN(parsedValue) &&
    parsedValue > spendable;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold mb-2">Stream Amount</h3>
        <p className="text-sm text-slate-400 mb-4">
          Enter the total amount you want to stream to the recipient.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <label
            htmlFor="amount"
            className="block text-sm font-medium text-foreground"
          >
            Amount {token && `(${token})`}
          </label>
          <div className="flex items-center gap-2">
            {isBalanceLoading ? (
              <span className="text-xs text-slate-500">Loading balance...</span>
            ) : isSpendableKnown ? (
              <span className="text-xs text-slate-500">
                Available: {spendable} {token}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onSetMax}
              disabled={!onSetMax || !canSetMax}
              className="px-2.5 py-1 rounded-full border border-accent/40 text-xs font-semibold text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Max
            </button>
          </div>
        </div>
        <div className="relative">
          <input
            ref={inputRef}
            id="amount"
            type="number"
            step="any"
            min="0"
            value={value}
            onChange={(e) => handleAmountChange(e.target.value)}
            placeholder="0.00"
            className={`w-full px-4 py-3 rounded-lg bg-glass border ${
              error || isOverBalance
                ? "border-red-500 focus:border-red-500 focus:ring-red-500"
                : "border-glass-border focus:border-accent focus:ring-accent"
            } focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground placeholder-slate-500`}
            aria-invalid={!!error || isOverBalance}
            aria-describedby={error || isOverBalance ? "amount-error" : undefined}
          />
          {token && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium">
              {token}
            </div>
          )}
        </div>
        {isXlm && !isBalanceLoading && isSpendableKnown && (
          <p className="mt-1 text-xs text-slate-500">
            {XLM_BASE_RESERVE} {token} is kept in reserve for network fees.
          </p>
        )}
        {(error || isOverBalance) && (
          <p
            id="amount-error"
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
            {error || "Amount exceeds wallet balance"}
          </p>
        )}
        {!error && !isOverBalance && balanceError && (
          <p className="mt-2 text-sm text-amber-400" role="status">
            {balanceError}
          </p>
        )}
      </div>

      {value && !error && !isOverBalance && parseFloat(value) > 0 && (
        <div className="mt-4 p-4 rounded-lg bg-accent/5 border border-accent/20">
          <p className="text-sm text-slate-300">
            You will stream <strong className="text-accent">{value} {token || ""}</strong> to the recipient.
          </p>
        </div>
      )}
    </div>
  );
};
