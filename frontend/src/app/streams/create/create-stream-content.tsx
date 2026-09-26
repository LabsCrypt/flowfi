"use client";

import React, { useEffect, useState, useCallback } from "react";
import { logger } from "@/lib/logger";
import {
  createStream,
  toBaseUnits,
  toDurationSeconds,
  getTokenAddress,
  toSorobanErrorMessage,
  TOKEN_ADDRESSES
} from "@/lib/soroban";
import { hasValidPrecision } from "@/utils/amount";
import { toast } from "react-hot-toast";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FileText, X } from "lucide-react";
import { useWallet } from "@/context/wallet-context";
import { useStreamForm } from "@/hooks/useStreamForm";

const TOKEN_DECIMALS = 7;

export default function CreateStreamContent() {
  const { status, session } = useWallet();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [nowTimestamp] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [txState, setTxState] = useState<"idle" | "signing" | "submitted" | "confirming">("idle");
  const [dismissedDraftBanner, setDismissedDraftBanner] = useState(false);

  // ── Shared form hook ────────────────────────────────────────────────────
  const {
    formData,
    errors,
    updateFormData,
    resetForm: _resetForm,
    validateAll,
    walletBalance,
    walletBalanceLoading,
    walletBalanceError,
    hasDraft,
    discardDraft,
    draftSavedAt,
  } = useStreamForm({
    walletPublicKey: session?.publicKey,
    enableDraftPersistence: true,
    initialData: { token: "XLM", duration: "30" },
  });

  // Handle recipient prefill from search params — but only if no draft is restored
  useEffect(() => {
    const recipientParam = searchParams.get("recipient");
    if (!recipientParam || hasDraft) return;

    import("@stellar/stellar-sdk").then(({ StrKey }) => {
      if (StrKey.isValidEd25519PublicKey(recipientParam)) {
        updateFormData({ recipient: recipientParam });
      } else {
        logger.warn("Ignoring malformed recipient query param", { recipientParam });
      }
    });
  }, [searchParams, hasDraft, updateFormData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status !== "connected" || !session) {
      toast.error("Please connect your wallet first.");
      return;
    }

    // Use the shared validation (checks recipient format, amount, precision, balance)
    if (!validateAll()) {
      // Show the first error as a toast for flat-form UX
      const firstError = Object.values(errors)[0];
      if (firstError) toast.error(firstError);
      return;
    }

    setLoading(true);
    setTxState("signing");

    try {
      const amountBigInt = toBaseUnits(formData.amount);
      const durationBigInt = toDurationSeconds(formData.duration, "days");
      const tokenAddress = getTokenAddress(formData.token);

      const result = await createStream(session, {
        recipient: formData.recipient,
        tokenAddress,
        amount: amountBigInt,
        durationSeconds: durationBigInt,
      });

      if (result.success) {
        setTxState("confirming");
        discardDraft();
        toast.success("Stream created successfully!");
        setTimeout(() => {
          setLoading(false);
          setTxState("idle");
          router.push("/dashboard");
        }, 2000);
      }
    } catch (error) {
      setLoading(false);
      setTxState("idle");
      logger.error("Stream creation failed:", error);
      toast.error(toSorobanErrorMessage(error));
    }
  };

  const getButtonText = () => {
    if (!loading) return "Start Streaming";
    switch (txState) {
      case "signing": return "Confirm in Wallet...";
      case "submitted": return "Submitting to Network...";
      case "confirming": return "Finalizing Stream...";
      default: return "Processing...";
    }
  };

  const handleDismissDraft = useCallback(() => {
    discardDraft();
    setDismissedDraftBanner(true);
  }, [discardDraft]);

  return (
    <div className="container mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/dashboard"
        className="mb-8 inline-flex items-center text-sm font-medium text-slate-400 hover:text-white transition-colors"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Dashboard
      </Link>

      {/* Resume draft banner */}
      {hasDraft && !dismissedDraftBanner && draftSavedAt && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/10 px-5 py-4 text-sm">
          <FileText className="h-5 w-5 text-accent flex-shrink-0" />
          <span className="flex-1">
            Resumed a saved draft from{" "}
            {new Date(draftSavedAt).toLocaleTimeString()}
            . You can continue editing or start fresh.
          </span>
          <button
            onClick={handleDismissDraft}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            Discard Draft
          </button>
        </div>
      )}

      <div className="glass-card rounded-3xl border-slate-800 p-8">
        <h1 className="mb-2 text-3xl font-bold">Create New Stream</h1>
        <p className="mb-8 text-slate-400">
          Set up a real-time payment stream to any Stellar address.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="recipient" className="text-sm font-medium text-slate-300">
              Recipient Address
            </label>
            <input
              id="recipient"
              type="text"
              placeholder="G..."
              className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors"
              value={formData.recipient}
              onChange={(e) => updateFormData({ recipient: e.target.value })}
              required
            />
            {errors.recipient && (
              <p className="text-xs text-red-400 mt-1" role="alert">{errors.recipient}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="create-stream-token" className="text-sm font-medium text-slate-300">
                Token
              </label>
              <select
                id="create-stream-token"
                className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors appearance-none"
                value={formData.token}
                onChange={(e) => updateFormData({ token: e.target.value })}
              >
                {Object.keys(TOKEN_ADDRESSES).map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="create-stream-amount" className="text-sm font-medium text-slate-300">
                Total Amount
              </label>
              <input
                id="create-stream-amount"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors"
                value={formData.amount}
                onChange={(e) => {
                  const newValue = e.target.value;
                  if (newValue === '' || /^\d*\.?\d*$/.test(newValue)) {
                    if (hasValidPrecision(newValue, TOKEN_DECIMALS)) {
                      updateFormData({ amount: newValue });
                    }
                  }
                }}
                required
              />
              {errors.amount && (
                <p className="text-xs text-red-400 mt-1" role="alert">{errors.amount}</p>
              )}
              {walletBalance && !errors.amount && (
                <p className="text-xs text-slate-500 mt-1">
                  Available: {walletBalance} {formData.token}
                </p>
              )}
              {walletBalanceLoading && (
                <p className="text-xs text-slate-500 mt-1">Loading balance…</p>
              )}
              {walletBalanceError && (
                <p className="text-xs text-yellow-500 mt-1">{walletBalanceError}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="create-stream-duration" className="text-sm font-medium text-slate-300">
              Duration (Days)
            </label>
            <input
              id="create-stream-duration"
              type="number"
              placeholder="30"
              className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors"
              value={formData.duration}
              onChange={(e) => updateFormData({ duration: e.target.value })}
              required
            />
            {errors.duration && (
              <p className="text-xs text-red-400 mt-1" role="alert">{errors.duration}</p>
            )}
          </div>

          <div className="rounded-2xl bg-accent/5 p-6 space-y-4">
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Streaming Rate</span>
              <span className="font-mono font-medium text-accent">
                {formData.amount && formData.duration 
                  ? (Number(formData.amount) / (Number(formData.duration) * 86400)).toFixed(8)
                  : "0.00000000"} {formData.token}/sec
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Estimated End Date</span>
              <span className="font-medium">
                {new Date(nowTimestamp + Number(formData.duration || 0) * 86400000).toLocaleDateString()}
              </span>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || status !== "connected"}
            className="w-full rounded-xl bg-accent py-4 text-lg font-bold text-background transition-all hover:opacity-90 disabled:opacity-50 active:scale-[0.98]"
          >
            {getButtonText()}
          </button>
          
          {status !== "connected" && (
            <p className="text-center text-sm text-red-400">
              Please connect your wallet to create a stream.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
