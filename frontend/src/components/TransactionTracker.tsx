"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, CheckCircle, XCircle, ExternalLink, RefreshCw, Clock, Ban, FileSearch } from "lucide-react";
import toast from "react-hot-toast";
import type { BackendStream } from "@/lib/api-types";

/**
 * TransactionTracker - Shared component for tracking on-chain transaction lifecycle
 *
 * States:
 * - idle: No active transaction
 * - signing: User is signing in wallet
 * - submitted: Transaction sent to network, waiting for ledger inclusion
 * - confirming: Transaction in ledger, polling indexer for confirmation
 * - confirmed: Indexer confirmed the change
 * - failed: Transaction failed on-chain or was rejected
 * - cancelled: User cancelled the action
 */

export type TransactionStatus =
  | "idle"
  | "signing"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed"
  | "cancelled";

export type TransactionAction =
  | "create"
  | "withdraw"
  | "topup"
  | "cancel"
  | "pause"
  | "resume";

interface TransactionTrackerProps {
  status: TransactionStatus;
  action: TransactionAction;
  txHash?: string;
  error?: string;
  errorCode?: string;
  onRetry?: () => void;
  onCancel?: () => void;
  streamId?: string;
  expectedChanges?: {
    depositedAmount?: string;
    withdrawnAmount?: string;
    isActive?: boolean;
    isPaused?: boolean;
  };
}

const STELLAR_EXPERT_BASE = process.env.NEXT_PUBLIC_STELLAR_EXPERT_URL ||
  "https://stellar.expert/explorer/testnet/tx";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/v1";

const POLL_INTERVAL = 3000; // 3 seconds as per requirements
const MAX_POLL_ATTEMPTS = 20; // Max 1 minute of polling

// Action labels for user-friendly messages
const ACTION_LABELS: Record<TransactionAction, { present: string; past: string }> = {
  create: { present: "Creating stream", past: "Stream created" },
  withdraw: { present: "Withdrawing", past: "Withdrawn" },
  topup: { present: "Topping up", past: "Topped up" },
  cancel: { present: "Cancelling stream", past: "Stream cancelled" },
  pause: { present: "Pausing stream", past: "Stream paused" },
  resume: { present: "Resuming stream", past: "Stream resumed" },
};

export default function TransactionTracker({
  status,
  action,
  txHash,
  error,
  errorCode,
  onRetry,
  onCancel,
  streamId,
  expectedChanges,
}: TransactionTrackerProps) {
  const [pollCount, setPollCount] = useState(0);
  const [streamData, setStreamData] = useState<BackendStream | null>(null);
  const [previousStreamData, setPreviousStreamData] = useState<BackendStream | null>(null);

  // Capture initial stream state when entering confirming state
  useEffect(() => {
    if (status === "confirming" && streamId && !previousStreamData) {
      fetch(`${API_BASE_URL}/streams/${streamId}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data) setPreviousStreamData(data);
        })
        .catch(console.error);
    }
  }, [status, streamId, previousStreamData]);

  // Poll for confirmation
  useEffect(() => {
    if (status !== "confirming" || !streamId) return;

    let cancelled = false;
    let attempts = 0;

    async function poll() {
      if (cancelled || attempts >= MAX_POLL_ATTEMPTS) {
        if (attempts >= MAX_POLL_ATTEMPTS && !cancelled) {
          toast.error("Confirmation timeout - please check explorer for status");
        }
        return;
      }

      attempts++;
      setPollCount(attempts);

      try {
        const res = await fetch(`${API_BASE_URL}/streams/${streamId}`);
        if (!res.ok) throw new Error("Failed to fetch stream status");

        const data: BackendStream = await res.json();
        setStreamData(data);

        // Check if expected changes are reflected
        const isConfirmed = checkConfirmation(data, expectedChanges);

        if (isConfirmed && !cancelled) {
          toast.success(`${ACTION_LABELS[action].past} successfully!`);
          return; // Stop polling, parent should transition to confirmed
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Polling error:", err);
        }
      }

      if (!cancelled) {
        setTimeout(poll, POLL_INTERVAL);
      }
    }

    poll();

    return () => {
      cancelled = true;
    };
  }, [status, streamId, action, expectedChanges]);

  // Reset state when returning to idle
  useEffect(() => {
    if (status === "idle") {
      setPollCount(0);
      setStreamData(null);
      setPreviousStreamData(null);
    }
  }, [status]);

  // Render based on status
  switch (status) {
    case "idle":
      return null;

    case "signing":
      return (
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <div className="absolute inset-0 h-5 w-5 animate-ping rounded-full bg-accent/20" />
            </div>
            <div>
              <p className="font-medium">Sign in Wallet</p>
              <p className="text-sm text-slate-400">
                {ACTION_LABELS[action].present} - confirm in your wallet
              </p>
            </div>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="mt-3 text-sm text-slate-400 hover:text-white transition"
            >
              Cancel
            </button>
          )}
        </div>
      );

    case "submitted":
      return (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-yellow-400" />
            <div>
              <p className="font-medium text-yellow-400">Transaction Submitted</p>
              <p className="text-sm text-yellow-400/70">
                Waiting for ledger inclusion...
              </p>
            </div>
          </div>

          {txHash && (
            <a
              href={`${STELLAR_EXPERT_BASE}/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition bg-blue-500/10 px-3 py-2 rounded-lg w-fit"
            >
              <FileSearch className="h-4 w-4" />
              View on Stellar Expert
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      );

    case "confirming":
      return (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Clock className="h-5 w-5 text-blue-400" />
              <Loader2 className="h-5 w-5 animate-spin absolute inset-0 text-blue-400" />
            </div>
            <div className="flex-1">
              <p className="font-medium text-blue-400">Confirming on Indexer</p>
              <p className="text-sm text-blue-400/70">
                Polling every 3s... (attempt {pollCount}/{MAX_POLL_ATTEMPTS})
              </p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-400 transition-all duration-300"
              style={{ width: `${Math.min(100, (pollCount / MAX_POLL_ATTEMPTS) * 100)}%` }}
            />
          </div>

          {txHash && (
            <a
              href={`${STELLAR_EXPERT_BASE}/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition"
            >
              <ExternalLink className="h-3 w-3" />
              Check transaction status
            </a>
          )}
        </div>
      );

    case "confirmed":
      return (
        <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <CheckCircle className="h-5 w-5 text-green-400" />
            <div>
              <p className="font-medium text-green-400">
                {ACTION_LABELS[action].past} Successfully
              </p>
              <p className="text-sm text-green-400/70">
                Transaction confirmed on indexer
              </p>
            </div>
          </div>

          {/* Summary of changes */}
          {streamData && previousStreamData && (
            <div className="mt-3 p-3 bg-green-500/5 rounded-lg border border-green-500/10">
              <p className="text-sm font-medium mb-2">Summary of Changes:</p>
              <div className="space-y-1 text-sm">
                {renderChanges(previousStreamData, streamData)}
              </div>
            </div>
          )}

          {txHash && (
            <a
              href={`${STELLAR_EXPERT_BASE}/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-green-400 hover:text-green-300 transition"
            >
              <ExternalLink className="h-3 w-3" />
              View transaction
            </a>
          )}
        </div>
      );

    case "failed":
      return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-red-400" />
            <div>
              <p className="font-medium text-red-400">Transaction Failed</p>
              <p className="text-sm text-red-400/70">
                {ACTION_LABELS[action].present} failed
              </p>
            </div>
          </div>

          {/* Error code and message */}
          <div className="space-y-2">
            {errorCode && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-400">Error Code:</span>
                <code className="px-2 py-0.5 bg-red-500/20 text-red-400 rounded">
                  {errorCode}
                </code>
              </div>
            )}
            {error && (
              <p className="text-sm text-red-300 bg-red-500/10 p-3 rounded-lg">
                {error}
              </p>
            )}
          </div>

          {/* Retry button */}
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition"
            >
              <RefreshCw className="h-4 w-4" />
              Retry Transaction
            </button>
          )}
        </div>
      );

    case "cancelled":
      return (
        <div className="rounded-xl border border-slate-500/20 bg-slate-500/10 p-4">
          <div className="flex items-center gap-3">
            <Ban className="h-5 w-5 text-slate-400" />
            <div>
              <p className="font-medium text-slate-400">Action Cancelled</p>
              <p className="text-sm text-slate-400/70">
                {ACTION_LABELS[action].present} was cancelled
              </p>
            </div>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 flex items-center gap-2 text-sm text-slate-400 hover:text-white transition"
            >
              <RefreshCw className="h-4 w-4" />
              Try Again
            </button>
          )}
        </div>
      );

    default:
      return null;
  }
}

// Helper function to check if indexer has reflected the changes
function checkConfirmation(
  current: BackendStream,
  expected?: TransactionTrackerProps["expectedChanges"]
): boolean {
  if (!expected) return true;

  if (expected.depositedAmount !== undefined) {
    if (current.depositedAmount !== expected.depositedAmount) return false;
  }
  if (expected.withdrawnAmount !== undefined) {
    if (current.withdrawnAmount !== expected.withdrawnAmount) return false;
  }
  if (expected.isActive !== undefined) {
    if (current.isActive !== expected.isActive) return false;
  }

  return true;
}

// Helper function to render changes between stream states
function renderChanges(prev: BackendStream, current: BackendStream) {
  const changes: JSX.Element[] = [];

  if (prev.depositedAmount !== current.depositedAmount) {
    const diff = BigInt(current.depositedAmount) - BigInt(prev.depositedAmount);
    changes.push(
      <div key="deposited" className="flex items-center gap-2">
        <span className="text-green-400">+</span>
        <span>Deposited: {formatAmount(diff, 7)} tokens added</span>
      </div>
    );
  }

  if (prev.withdrawnAmount !== current.withdrawnAmount) {
    const diff = BigInt(current.withdrawnAmount) - BigInt(prev.withdrawnAmount);
    changes.push(
      <div key="withdrawn" className="flex items-center gap-2">
        <span className="text-blue-400">↓</span>
        <span>Withdrawn: {formatAmount(diff, 7)} tokens</span>
      </div>
    );
  }

  if (prev.isActive !== current.isActive) {
    changes.push(
      <div key="status" className="flex items-center gap-2">
        <span className={current.isActive ? "text-green-400" : "text-red-400"}>
          {current.isActive ? "●" : "○"}
        </span>
        <span>Status: {current.isActive ? "Active" : "Inactive"}</span>
      </div>
    );
  }

  if (changes.length === 0) {
    return <span className="text-slate-400">No significant changes detected</span>;
  }

  return changes;
}

// Helper to format amounts
function formatAmount(raw: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Hook for using transaction tracker in components
export function useTransactionTracker() {
  const [status, setStatus] = useState<TransactionStatus>("idle");
  const [txHash, setTxHash] = useState<string>();
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(undefined);
    setError(undefined);
    setErrorCode(undefined);
  }, []);

  const start = useCallback(() => {
    setStatus("signing");
    setError(undefined);
    setErrorCode(undefined);
  }, []);

  const submit = useCallback((hash: string) => {
    setTxHash(hash);
    setStatus("submitted");
  }, []);

  const confirm = useCallback(() => {
    setStatus("confirming");
  }, []);

  const succeed = useCallback(() => {
    setStatus("confirmed");
  }, []);

  const fail = useCallback((err: string, code?: string) => {
    setStatus("failed");
    setError(err);
    setErrorCode(code);
  }, []);

  const cancel = useCallback(() => {
    setStatus("cancelled");
  }, []);

  return {
    status,
    txHash,
    error,
    errorCode,
    reset,
    start,
    submit,
    confirm,
    succeed,
    fail,
    cancel,
  };
}

export default TransactionTracker;
