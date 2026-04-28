"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle, XCircle, ExternalLink, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";

export type TransactionStatus =
  | "idle"
  | "signing"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed";

interface TransactionTrackerProps {
  status: TransactionStatus;
  txHash?: string;
  error?: string;
  onRetry?: () => void;
  streamId?: string;
  pollInterval?: number;
}

const STELLAR_EXPERT_BASE =
  "https://stellar.expert/explorer/testnet/tx";

export default function TransactionTracker({
  status,
  txHash,
  error,
  onRetry,
  streamId,
  pollInterval = 2000,
}: TransactionTrackerProps) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (status !== "submitted" || !streamId) return;

    let cancelled = false;
    setConfirming(true);

    async function poll() {
      try {
        const res = await fetch(`/v1/streams/${streamId}`);
        if (!res.ok) throw new Error("Failed to fetch stream status");

        const data = await res.json();
        if (data.confirmed && !cancelled) {
          toast.success("Transaction confirmed!");
          setConfirming(false);
          return;
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Polling error:", err);
        }
      }

      if (!cancelled) {
        setTimeout(poll, pollInterval);
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [status, streamId, pollInterval]);

  if (status === "idle" || status === "signing") {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        {status === "signing" && (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Signing transaction...</span>
          </>
        )}
      </div>
    );
  }

  if (status === "submitted") {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
        <div className="flex items-center gap-2 text-yellow-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="font-medium">Transaction Submitted</span>
        </div>

        {txHash && (
          <a
            href={`${STELLAR_EXPERT_BASE}/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300 transition"
          >
            View on Stellar Expert
            <ExternalLink className="h-3 w-3" />
          </a>
        )}

        {confirming && (
          <p className="text-xs text-gray-400">
            Waiting for confirmation...
          </p>
        )}
      </div>
    );
  }

  if (status === "confirmed") {
    return (
      <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
        <div className="flex items-center gap-2 text-green-400">
          <CheckCircle className="h-5 w-5" />
          <span className="font-medium">Transaction Confirmed</span>
        </div>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 space-y-3">
        <div className="flex items-center gap-2 text-red-400">
          <XCircle className="h-5 w-5" />
          <span className="font-medium">Transaction Failed</span>
        </div>

        {error && (
          <p className="text-sm text-red-300 bg-red-500/10 p-2 rounded-lg">
            {error}
          </p>
        )}

        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition"
          >
            <RefreshCw className="h-4 w-4" />
            Retry Transaction
          </button>
        )}
      </div>
    );
  }

  return null;
}
