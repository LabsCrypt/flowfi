"use client";

/**
 * TopUpModal.tsx 
 *
 * Replaces the prompt() / alert() in dashboard-view.tsx handleTopUp.
 * Collects an amount, shows a confirmation summary, and calls onConfirm.
 */

import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { hasValidPrecision, validateAmountInput } from "@/utils/amount";
import { useModalDialog } from "@/hooks/useModalDialog";
import toast from "react-hot-toast";
import { transactionSuccessToast } from "@/lib/transaction-feedback";

export const SECONDS_PER_DAY = 86_400;
export const RUNWAY_PRESET_DAYS = [7, 30, 90] as const;

export function calculateRunwayPresetAmount(
  ratePerSecond: number,
  days: number,
  decimals = 7,
): string {
  if (
    !Number.isFinite(ratePerSecond) ||
    ratePerSecond <= 0 ||
    !Number.isFinite(days) ||
    days <= 0
  ) {
    return "0";
  }
  const raw = ratePerSecond * SECONDS_PER_DAY * days;
  return raw.toFixed(decimals).replace(/\.?0+$/, "");
}

export function calculateProjectedEndDate(
  topUpAmount: number,
  ratePerSecond: number,
  currentEndTime?: number | Date,
  now: Date = new Date(),
): Date | null {
  if (
    !Number.isFinite(topUpAmount) ||
    topUpAmount <= 0 ||
    !Number.isFinite(ratePerSecond) ||
    ratePerSecond <= 0
  ) {
    return null;
  }
  let baseMs: number;
  if (currentEndTime instanceof Date) {
    baseMs = currentEndTime.getTime();
  } else if (typeof currentEndTime === "number" && Number.isFinite(currentEndTime) && currentEndTime > 0) {
    baseMs = currentEndTime < 1e12 ? currentEndTime * 1000 : currentEndTime;
  } else {
    baseMs = now.getTime();
  }
  const additionalMs = (topUpAmount / ratePerSecond) * 1000;
  return new Date(baseMs + additionalMs);
}

export function formatProjectedEndDate(date: Date): string {
  const isoDate = date.toISOString().split("T")[0] ?? "";
  const readable = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${readable} (${isoDate})`;
}

interface TopUpModalProps {
  streamId: string;
  token: string;
  currentDeposited: number;
  ratePerSecond?: number;
  currentEndTime?: number | Date;
  onConfirm: (streamId: string, amount: string) => Promise<void>;
  onClose: () => void;
}

export const TopUpModal: React.FC<TopUpModalProps> = ({
  streamId,
  token,
  currentDeposited,
  ratePerSecond,
  currentEndTime,
  onConfirm,
  onClose,
}) => {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const dialogRef = useModalDialog({
    onClose,
    isCloseDisabled: isSubmitting,
    initialFocusRef: inputRef,
  });

  // Token decimals - using 7 as default (Stellar standard)
  const TOKEN_DECIMALS = 7;

  const hasValidRate =
    typeof ratePerSecond === "number" &&
    Number.isFinite(ratePerSecond) &&
    ratePerSecond > 0;

  const handlePresetClick = (days: number) => {
    if (!hasValidRate || ratePerSecond === undefined) return;
    const presetAmount = calculateRunwayPresetAmount(
      ratePerSecond,
      days,
      TOKEN_DECIMALS,
    );
    setAmount(presetAmount);
    if (error) setError(null);
  };

  const validate = (): boolean => {
    const validationError = validateAmountInput(amount, TOKEN_DECIMALS);
    if (validationError) {
      setError(validationError);
      return false;
    }
    if (!hasValidPrecision(amount, 7)) {
      setError("Amount exceeds maximum precision (7 decimal places).");
      return false;
    }
    setError(null);
    return true;
  };

  const handleConfirm = async () => {
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      await onConfirm(streamId, amount);
      transactionSuccessToast(`Successfully added ${amount} ${token} to stream`);
    } catch {
      toast.error("Failed to top up stream. Please try again.");
      setIsSubmitting(false);
    }
  };

  const parsedAmount = parseFloat(amount);
  const newTotal = !isNaN(parsedAmount) && parsedAmount > 0
    ? currentDeposited + parsedAmount
    : null;
  const projectedEndDate =
    newTotal !== null && hasValidRate && ratePerSecond !== undefined
      ? calculateProjectedEndDate(parsedAmount, ratePerSecond, currentEndTime)
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="topup-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="glass-card relative w-full max-w-md mx-4 rounded-2xl border border-glass-border p-8"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 id="topup-modal-title" className="text-xl font-bold">Top Up Stream</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-400 hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Stream info */}
        <div className="mb-6 p-3 rounded-lg bg-white/5 border border-glass-border text-sm">
          <p className="text-slate-400">
            Stream <code className="text-accent font-mono text-xs">{streamId}</code>
          </p>
          <p className="text-slate-300 mt-1">
            Current balance: <strong className="text-foreground">{currentDeposited} {token}</strong>
          </p>
        </div>

        {/* Amount input */}
        <div className="mb-4">
          <label htmlFor="topup-amount" className="block text-sm font-medium mb-2 text-foreground">
            Amount to add ({token})
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              id="topup-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                const newValue = e.target.value;
                // Only allow valid number characters and check precision
                if (newValue === '' || /^\d*\.?\d*$/.test(newValue)) {
                  if (hasValidPrecision(newValue, TOKEN_DECIMALS)) {
                    setAmount(newValue);
                    if (error) setError(null);
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleConfirm();
              }}
              placeholder="0.00"
              disabled={isSubmitting}
              className={`w-full px-4 py-3 rounded-lg bg-glass border ${
                error
                  ? "border-red-500 focus:border-red-500"
                  : "border-glass-border focus:border-accent"
              } focus:outline-none focus:ring-2 focus:ring-accent/50 transition-colors text-foreground placeholder-slate-500 disabled:opacity-50`}
              aria-invalid={!!error}
              aria-describedby={error ? "topup-error" : undefined}
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium text-sm pointer-events-none">
              {token}
            </span>
          </div>

          <div
            className="mt-3 flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Quick runway presets"
          >
            {RUNWAY_PRESET_DAYS.map((days) => (
              <button
                key={days}
                type="button"
                disabled={isSubmitting || !hasValidRate}
                onClick={() => handlePresetClick(days)}
                className="px-3 py-1 rounded-full text-xs font-medium border border-glass-border bg-white/5 text-slate-300 hover:border-accent hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                +{days} Days
              </button>
            ))}
          </div>

          {error && (
            <p id="topup-error" className="mt-2 text-sm text-red-400 flex items-center gap-1" role="alert">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </p>
          )}
        </div>

        {/* Preview */}
        {newTotal !== null && (
          <div className="mb-6 p-3 rounded-lg bg-accent/5 border border-accent/20 text-sm">
            <p className="text-slate-300">
              New total:{" "}
              <strong className="text-accent">
                {newTotal.toFixed(2)} {token}
              </strong>
            </p>
            {projectedEndDate !== null && (
              <p
                className="text-slate-300 mt-1"
                data-testid="projected-end-date"
              >
                Projected end date:{" "}
                <strong className="text-accent">
                  {formatProjectedEndDate(projectedEndDate)}
                </strong>
              </p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleConfirm()} loading={isSubmitting} glow>
            {isSubmitting ? "Topping up…" : "Confirm Top Up"}
          </Button>
        </div>
      </div>
    </div>
  );
};
