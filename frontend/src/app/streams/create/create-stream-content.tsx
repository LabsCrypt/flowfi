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
import { hasValidPrecision, validateAmountInput } from "@/utils/amount";
import { toast } from "react-hot-toast";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FileText, X } from "lucide-react";
import { useWallet } from "@/context/wallet-context";

const TOKEN_DECIMALS = 7;
const DRAFT_STORAGE_KEY = "flowfi.create-stream.draft.v1";

interface StreamDraft {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
  savedAt: number;
}

interface FormFields {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
}

const DEFAULT_FORM: FormFields = {
  recipient: "",
  token: "XLM",
  amount: "",
  duration: "30",
};

function isPristineForm(form: FormFields): boolean {
  return (
    form.recipient === "" &&
    form.token === DEFAULT_FORM.token &&
    form.amount === "" &&
    form.duration === DEFAULT_FORM.duration
  );
}

function saveDraftToSession(data: StreamDraft): void {
  try {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // sessionStorage may be full or unavailable
  }
}

function loadDraftFromSession(): StreamDraft | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StreamDraft;
    // Reject empty drafts so a bogus "resumed draft" banner is never shown
    // over a blank form.
    if (
      parsed &&
      typeof parsed.recipient === "string" &&
      typeof parsed.amount === "string" &&
      (parsed.recipient.trim() !== "" || parsed.amount.trim() !== "")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearDraft(): void {
  try {
    if (typeof window === "undefined") return;
    sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export default function CreateStreamContent() {
  const { status, session } = useWallet();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [nowTimestamp] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [txState, setTxState] = useState<"idle" | "signing" | "submitted" | "confirming">("idle");
  // Read the draft once at mount so the banner has a stable savedAt value
  // instead of re-reading sessionStorage on every render.
  const [restoredDraft, setRestoredDraft] = useState<StreamDraft | null>(
    () => loadDraftFromSession()
  );
  const [dismissedDraftBanner, setDismissedDraftBanner] = useState(false);
  const draftRestored = restoredDraft !== null;

  const [formData, setFormData] = useState<FormFields>(() => {
    if (restoredDraft) {
      return {
        recipient: restoredDraft.recipient,
        token: restoredDraft.token,
        amount: restoredDraft.amount,
        duration: restoredDraft.duration,
      };
    }
    return { ...DEFAULT_FORM };
  });

  // Persist form data to sessionStorage whenever it changes — but never
  // write an empty draft for a pristine form on first mount.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isPristineForm(formData)) return;
      saveDraftToSession({
        recipient: formData.recipient,
        token: formData.token,
        amount: formData.amount,
        duration: formData.duration,
        savedAt: Date.now(),
      });
    }, 500); // debounce writes
    return () => clearTimeout(timer);
  }, [formData]);

  // Handle recipient prefill from search params — but only if no draft is restored
  useEffect(() => {
    const recipientParam = searchParams.get("recipient");
    if (!recipientParam || draftRestored) return;

    import("@stellar/stellar-sdk").then(({ StrKey }) => {
      if (StrKey.isValidEd25519PublicKey(recipientParam)) {
        setFormData((prev) => ({ ...prev, recipient: recipientParam }));
      } else {
        logger.warn("Ignoring malformed recipient query param", { recipientParam });
      }
    });
  }, [searchParams, draftRestored]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status !== "connected" || !session) {
      toast.error("Please connect your wallet first.");
      return;
    }

    const validationError = validateAmountInput(formData.amount, TOKEN_DECIMALS);
    if (validationError) {
      toast.error(validationError);
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
        clearDraft();
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

  const amountError = formData.amount
    ? validateAmountInput(formData.amount, TOKEN_DECIMALS)
    : null;

  const handleDismissDraft = useCallback(() => {
    clearDraft();
    setRestoredDraft(null);
    setDismissedDraftBanner(true);
    setFormData({ ...DEFAULT_FORM });
  }, []);

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
      {restoredDraft && !dismissedDraftBanner && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/10 px-5 py-4 text-sm">
          <FileText className="h-5 w-5 text-accent flex-shrink-0" />
          <span className="flex-1">
            Resumed a saved draft from{" "}
            {new Date(restoredDraft.savedAt).toLocaleTimeString()}
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
              onChange={(e) => setFormData({ ...formData, recipient: e.target.value })}
              required
            />
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
                onChange={(e) => setFormData({ ...formData, token: e.target.value })}
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
                      setFormData({ ...formData, amount: newValue });
                    }
                  }
                }}
                required
              />
              {amountError && (
                <p className="text-xs text-red-400 mt-1">{amountError}</p>
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
              onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
              required
            />
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
