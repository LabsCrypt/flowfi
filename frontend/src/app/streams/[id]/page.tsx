"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import LiveCounter from "@/components/Livecounter";
import ProgressBar from "@/components/Progressbar";
import { CancelStreamModal } from "@/components/streams/CancelStreamModal";
import TransactionTracker, {
  type TransactionStatus,
} from "@/components/TransactionTracker";
import { Button } from "@/components/ui/Button";
import toast from "react-hot-toast";
import { useWallet } from "@/context/wallet-context";
import { useCancelStream } from "@/hooks/useCancelStream";
import { useStreamEvents } from "@/hooks/useStreamEvents";
import { useWithdrawStream } from "@/hooks/useWithdrawStream";
import {
  topUpStream,
  pauseStream,
  resumeStream,
  toSorobanErrorMessage,
} from "@/lib/soroban";
import { formatAmount, parseAmount, hasValidPrecision, formatRate } from "@/lib/amount";
import type { WalletSession } from "@/lib/wallet";
interface StreamDetail {
  id: string;
  sender: string;
  recipient: string;
  tokenAddress: string;
  depositedAmount: string;
  withdrawnAmount: string;
  ratePerSecond: string;
  startTime: number;
  lastUpdateTime: number;
  isActive: boolean;
  status: string;
  isPaused?: boolean;
  pausedAt?: string;
}

export default function StreamDetailsPage() {
  const params = useParams();
  const streamId = params.id as string;
  const { session, isHydrated } = useWallet();
  
  const [stream, setStream] = useState<StreamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [showTopUp, setShowTopUp] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [withdrawTxHash, setWithdrawTxHash] = useState<string | undefined>();
  const [withdrawStatus, setWithdrawStatus] = useState<TransactionStatus>("idle");
  const [withdrawError, setWithdrawError] = useState<string | undefined>();
  const { cancel: cancelStream, isPending: cancelling } = useCancelStream<StreamDetail>();
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [pauseResumeStatus, setPauseResumeStatus] =
    useState<TransactionStatus>("idle");
  const [pauseResumeTxHash, setPauseResumeTxHash] = useState<string | undefined>(
    undefined,
  );
  const [pauseResumeError, setPauseResumeError] = useState<string | undefined>(
    undefined,
  );
  const { withdraw: withdrawStream, isPending: withdrawing } = useWithdrawStream();

  // SSE integration for real-time stream updates
  const { events: streamEvents } = useStreamEvents({
    streamIds: [streamId],
    autoReconnect: true,
  });

  const fetchStream = useCallback(async () => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const response = await fetch(`${baseUrl}/v1/streams/${streamId}`);
      if (!response.ok) {
        throw new Error("Stream not found");
      }
      const data = await response.json();
      setStream(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch stream");
    } finally {
      setLoading(false);
    }
  }, [streamId]);

  useEffect(() => {
    if (!isHydrated || !session || !streamId) {
      return;
    }

    void fetchStream();
  }, [fetchStream, isHydrated, session, streamId]);

  // Handle SSE events to update stream state in real-time
  useEffect(() => {
    if (streamEvents.length > 0) {
      const latestEvent = streamEvents[0];
      console.log('Stream event received:', latestEvent);
      
      void fetchStream();
    }
  }, [fetchStream, streamEvents]);

  const handleWithdraw = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    setWithdrawStatus("idle");
    setWithdrawError(undefined);

    try {
      const { txHash } = await withdrawStream(streamId);
      setWithdrawTxHash(txHash);
      setWithdrawStatus("submitted");
      setStream((current) =>
        current
          ? {
              ...current,
              withdrawnAmount: current.depositedAmount,
              lastUpdateTime: Math.floor(Date.now() / 1000),
            }
          : current,
      );
      toast.success("Withdraw transaction submitted.");
      void fetchStream();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to withdraw stream.";
      setWithdrawError(message);
      setWithdrawStatus("failed");
      toast.error(message);
    }
  };

  const handleConfirmCancel = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    try {
      const cancelledStream = await cancelStream(streamId);
      setStream((current) => ({
        ...(current ?? cancelledStream),
        ...cancelledStream,
        status: "CANCELLED",
        isActive: false,
      }));
      setShowCancelModal(false);
      toast.success("Stream cancelled successfully.");
      void fetchStream();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel stream.");
    }
  };

  const handleTopUp = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    if (!topUpAmount || parseFloat(topUpAmount) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (!hasValidPrecision(topUpAmount, 7)) {
      toast.error("Amount exceeds maximum precision (7 decimal places)");
      return;
    }

    try {
      await topUpStream(session, {
        streamId: BigInt(streamId),
        amount: parseAmount(topUpAmount, 7),
      });
      toast.success("Stream topped up successfully!");
      setShowTopUp(false);
      setTopUpAmount("");
      // Refresh stream data
      window.location.reload();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    }
  };

  const refetchStream = async () => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
      const response = await fetch(`${baseUrl}/v1/streams/${streamId}`);
      if (response.ok) {
        const data = await response.json();
        setStream(data);
      }
    } catch (err) {
      console.error("Failed to refresh stream:", err);
    }
  };

  const handlePause = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    setPausing(true);
    setPauseResumeError(undefined);
    setPauseResumeTxHash(undefined);
    setPauseResumeStatus("signing");
    try {
      const result = await pauseStream(session, {
        streamId: BigInt(streamId),
      });
      setPauseResumeTxHash(result.txHash);
      setPauseResumeStatus("submitted");
      toast.success("Stream pause submitted!");
      await refetchStream();
      setPauseResumeStatus("confirmed");
    } catch (err) {
      const message = toSorobanErrorMessage(err);
      setPauseResumeError(message);
      setPauseResumeStatus("failed");
      toast.error(message);
    } finally {
      setPausing(false);
    }
  };

  const handleResume = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    setResuming(true);
    setPauseResumeError(undefined);
    setPauseResumeTxHash(undefined);
    setPauseResumeStatus("signing");
    try {
      const result = await resumeStream(session, {
        streamId: BigInt(streamId),
      });
      setPauseResumeTxHash(result.txHash);
      setPauseResumeStatus("submitted");
      toast.success("Stream resume submitted!");
      await refetchStream();
      setPauseResumeStatus("confirmed");
    } catch (err) {
      const message = toSorobanErrorMessage(err);
      setPauseResumeError(message);
      setPauseResumeStatus("failed");
      toast.error(message);
    } finally {
      setResuming(false);
    }
  };

  if (loading) {
    return (
      <main style={{ minHeight: "100vh", padding: "clamp(1rem, 3vw, 2rem)" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <p>Loading stream details...</p>
        </div>
      </main>
    );
  }

  if (error || !stream) {
    return (
      <main style={{ minHeight: "100vh", padding: "clamp(1rem, 3vw, 2rem)" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <p style={{ color: "red" }}>{error || "Stream not found"}</p>
        </div>
      </main>
    );
  }

  const deposited = parseFloat(formatAmount(BigInt(stream.depositedAmount), 7));
  const withdrawn = parseFloat(formatAmount(BigInt(stream.withdrawnAmount), 7));
  const claimable = deposited - withdrawn;
  const displayedClaimable = withdrawStatus === "submitted" ? 0 : claimable;
  const percentage = Math.round((withdrawn / deposited) * 100);
  const normalizedStatus = (
    stream.status ||
    (stream.isPaused ? "PAUSED" : stream.isActive ? "ACTIVE" : "COMPLETED")
  ).toUpperCase();
  const displayStatus =
    stream.status || (stream.isPaused ? "PAUSED" : stream.isActive ? "ACTIVE" : "COMPLETED");
  const isConnectedSender =
    Boolean(session?.publicKey) &&
    session?.publicKey.toLowerCase() === stream.sender.toLowerCase();
  const isConnectedRecipient =
    Boolean(session?.publicKey) &&
    session?.publicKey.toLowerCase() === stream.recipient.toLowerCase();
  const canCancelStream =
    isConnectedSender && (normalizedStatus === "ACTIVE" || normalizedStatus === "PAUSED");
  const hasClaimableAmount = displayedClaimable > 0;
  const canWithdrawStream = isConnectedRecipient && hasClaimableAmount;

  return (
    <main style={{ minHeight: "100vh", padding: "clamp(1rem, 3vw, 2rem)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: "1rem" }}>

        {/* Header */}
        <div>
          <p className="kicker">Stream #{streamId}</p>
          <h1 style={{ margin: "0.4rem 0 0", fontSize: "clamp(1.6rem, 3vw, 2.2rem)", lineHeight: 1.1 }}>
            Stream Details
          </h1>
        </div>

        {/* Identity card */}
        <div className="dashboard-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.15rem" }}>
                Status: {displayStatus}
              </h2>
              <p style={{ margin: "0.2rem 0", color: "var(--text-muted)" }}>
                Sender:{" "}
                <code
                  style={{
                    background: "rgba(19,38,61,0.07)",
                    borderRadius: "0.4rem",
                    padding: "0.15rem 0.45rem",
                    fontSize: "0.85rem",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  {stream.sender.slice(0, 8)}...{stream.sender.slice(-4)}
                </code>
              </p>
              <p style={{ margin: "0.2rem 0", color: "var(--text-muted)" }}>
                Recipient:{" "}
                <code
                  style={{
                    background: "rgba(19,38,61,0.07)",
                    borderRadius: "0.4rem",
                    padding: "0.15rem 0.45rem",
                    fontSize: "0.85rem",
                    fontFamily: "var(--font-mono, monospace)",
                  }}
                >
                  {stream.recipient.slice(0, 8)}...{stream.recipient.slice(-4)}
                </code>
              </p>
              <p style={{ margin: "0.2rem 0", color: "var(--text-muted)" }}>
                Token: {stream.tokenAddress.slice(0, 8)}...
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ margin: "0.2rem 0", fontSize: "0.9rem" }}>
                Rate: {formatRate(BigInt(stream.ratePerSecond), 7)}
              </p>
              <p style={{ margin: "0.2rem 0", fontSize: "0.9rem" }}>
                Started: {new Date(stream.startTime * 1000).toLocaleDateString()}
              </p>
            </div>
          </div>
        </div>

        {/* Paused banner */}
        {stream.isPaused && (
          <div className="dashboard-panel" style={{ backgroundColor: "rgba(251, 191, 36, 0.1)", border: "1px solid rgba(251, 191, 36, 0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "1.2rem" }}>⏸️</span>
              <div>
                <h4 style={{ margin: "0", color: "#f59e0b" }}>Stream Paused</h4>
                <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem", color: "var(--text-muted)" }}>
                  {stream.pausedAt ? `Paused at ${new Date(parseInt(stream.pausedAt) * 1000).toLocaleString()}` : 'Stream is currently paused'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Progress bar */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Stream Progress</h3>
          </div>
          <ProgressBar
            percentage={percentage}
            label={`${withdrawn.toFixed(2)} / ${deposited.toFixed(2)} tokens withdrawn`}
          />
        </div>

        {/* Live counter */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Claimable Balance</h3>
          </div>
          <LiveCounter
            initial={displayedClaimable}
            label="Available to withdraw"
            isPaused={stream.isPaused}
            pausedAt={stream.pausedAt}
          />
        </div>

        {/* Actions */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Actions</h3>
          </div>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            {canWithdrawStream && (
              <Button
                onClick={() => void handleWithdraw()}
                disabled={withdrawing || withdrawStatus === "submitted"}
                glow
              >
                {withdrawing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Withdrawing...
                  </>
                ) : (
                  "Withdraw"
                )}
              </Button>
            )}
            <Button
              onClick={() => setShowTopUp(!showTopUp)}
              disabled={!stream.isActive}
              variant="outline"
            >
              {showTopUp ? "Cancel Top-Up" : "Top Up"}
            </Button>
            {canCancelStream && (
              <Button
                onClick={() => setShowCancelModal(true)}
                disabled={cancelling}
                style={{ borderColor: "#ef4444", color: "#ef4444" }}
                variant="outline"
              >
                Cancel Stream
              </Button>
            )}
            {/* Pause button - show for active streams owned by sender */}
            {stream.isActive && !stream.isPaused && session?.publicKey === stream.sender && (
              <Button
                onClick={handlePause}
                disabled={pausing}
                style={{ borderColor: "#f59e0b", color: "#f59e0b" }}
                variant="outline"
              >
                {pausing ? "Pausing..." : "Pause Stream"}
              </Button>
            )}
            {/* Resume button - show for paused streams owned by sender */}
            {stream.isActive && stream.isPaused && session?.publicKey === stream.sender && (
              <Button
                onClick={handleResume}
                disabled={resuming}
                glow
              >
                {resuming ? "Resuming..." : "Resume Stream"}
              </Button>
            )}
            <Button
              onClick={() => setShowCancelModal(true)}
              disabled={cancelling || !stream.isActive}
              style={{ borderColor: "#ef4444", color: "#ef4444" }}
              variant="outline"
            >
              {cancelling ? "Cancelling..." : "Cancel Stream"}
            </Button>
          </div>

          {showTopUp && (
            <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
              <input
                type="number"
                placeholder="Amount"
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                style={{
                  padding: "0.5rem",
                  borderRadius: "0.25rem",
                  border: "1px solid var(--glass-border)",
                  background: "rgba(255,255,255,0.05)",
                  color: "inherit",
                }}
              />
              <Button onClick={handleTopUp}>Add Funds</Button>
            </div>
          )}

          {pauseResumeStatus !== "idle" && (
            <div style={{ marginTop: "1rem" }}>
              <TransactionTracker
                status={pauseResumeStatus}
                txHash={pauseResumeTxHash}
                error={pauseResumeError}
                onRetry={
                  pauseResumeStatus === "failed"
                    ? stream.isPaused
                      ? handleResume
                      : handlePause
                    : undefined
                }
              />
            </div>
          )}
          {withdrawStatus !== "idle" && (
            <div style={{ marginTop: "1rem" }}>
              <TransactionTracker
                status={withdrawStatus}
                txHash={withdrawTxHash}
                error={withdrawError}
                streamId={streamId}
                onRetry={() => void handleWithdraw()}
              />
            </div>
          )}
        </div>

        {/* Transaction history */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Transaction History</h3>
            <span>Recent activity</span>
          </div>
          <div className="mini-empty-state">
            <p>Transaction history will be populated from backend events.</p>
          </div>
        </div>

      </div>
      <CancelStreamModal
        isOpen={showCancelModal}
        isCancelling={cancelling}
        streamId={streamId}
        onClose={() => setShowCancelModal(false)}
        onConfirm={() => void handleConfirmCancel()}
      />
    </main>
  );
}
