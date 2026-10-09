"use client";

/**
 * components/wallet/SignerThresholdBadge.tsx
 *
 * Compact visualization of a Stellar account's multisig configuration and, when
 * a `collectedWeight` is supplied, the current signing progress (issue #1471).
 *
 * Renders nothing eye-catching for plain single-signature accounts beyond a
 * subdued hint, so it is safe to drop next to the wallet chip.
 */

import {
  requiredWeightForLevel,
  type MultisigAccount,
  type ThresholdLevel,
} from "@/lib/stellar-multisig";

interface SignerThresholdBadgeProps {
  account: MultisigAccount;
  /** Threshold category to display/measure against. Defaults to "high". */
  level?: ThresholdLevel;
  /** Weight already collected by a partial envelope, if any. */
  collectedWeight?: number;
  /** Signer keys already present in the envelope, if known. */
  signedSigners?: string[];
  className?: string;
}

const LEVEL_LABELS: Record<ThresholdLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function SignerThresholdBadge({
  account,
  level = "high",
  collectedWeight,
  signedSigners,
  className = "",
}: SignerThresholdBadgeProps) {
  const requiredWeight = requiredWeightForLevel(account.thresholds, level);

  if (!account.isMultisig) {
    return (
      <span
        data-testid="signer-threshold-badge"
        data-multisig="false"
        className={`inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-glass px-3 py-1 text-xs text-slate-400 ${className}`}
      >
        Single-signature account
      </span>
    );
  }

  const signedCount = signedSigners?.length ?? 0;
  const totalSignerCount = account.signers.length;
  const progress =
    collectedWeight === undefined || requiredWeight <= 0
      ? null
      : Math.min(100, Math.round((collectedWeight / requiredWeight) * 100));
  const isSatisfied = collectedWeight !== undefined && collectedWeight >= requiredWeight;

  const summary =
    collectedWeight === undefined
      ? `${totalSignerCount} signers · ${LEVEL_LABELS[level]} threshold ${requiredWeight}`
      : `${signedCount} of ${totalSignerCount} signatures collected (weight ${collectedWeight}/${requiredWeight})`;

  return (
    <div
      data-testid="signer-threshold-badge"
      data-multisig="true"
      data-satisfied={isSatisfied ? "true" : undefined}
      className={`inline-flex flex-col gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs ${className}`}
      aria-label={summary}
    >
      <div className="flex items-center gap-2 font-medium text-amber-300">
        <svg
          className="h-4 w-4 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 11c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zm0 0c-2.667 0-8 1.333-8 4v2h16v-2c0-2.667-5.333-4-8-4z"
          />
        </svg>
        <span>{summary}</span>
      </div>

      {progress !== null && (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className={`h-full rounded-full transition-all ${
              isSatisfied ? "bg-emerald-400" : "bg-amber-400"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
