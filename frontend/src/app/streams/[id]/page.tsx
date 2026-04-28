"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import LiveCounter from "@/components/Livecounter";
import ProgressBar from "@/components/Progressbar";
import { Button } from "@/components/ui/Button";
import toast from "react-hot-toast";
import { useWallet } from "@/context/wallet-context";
import { useStreamEvents } from "@/hooks/useStreamEvents";
import {
  withdrawFromStream,
  cancelStream,
  topUpStream,
  toSorobanErrorMessage,
} from "@/lib/soroban";
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
  const router = useRouter();
  const streamId = params.id as string;
  const { session, isHydrated } = useWallet();
  
  const [stream, setStream] = useState<StreamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [showTopUp, setShowTopUp] = useState(false);

  // SSE integration for real-time stream updates
  const { events: streamEvents, connected, reconnecting } = useStreamEvents({
    streamIds: [streamId],
    autoReconnect: true,
  });

  useEffect(() => {
    if (!isHydrated || !session) {
      return;
    }

    async function fetchStream() {
      try {
        const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
        const response = await fetch(`${baseUrl}/v1/streams/${streamId}`);
        if (!response.ok) {
          throw new Error("Stream not found");
        }
        const data = await response.json();
        setStream(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch stream");
      } finally {
        setLoading(false);
      }
    }

    if (streamId) {
      fetchStream();
    }
  }, [streamId, session, isHydrated]);

  // Handle SSE events to update stream state in real-time
  useEffect(() => {
    if (streamEvents.length > 0) {
      const latestEvent = streamEvents[0];
      console.log('Stream event received:', latestEvent);
      
      // Re-fetch stream data to get the latest state from server
      async function refetchStream() {
        try {
          const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
          const response = await fetch(`${baseUrl}/v1/streams/${streamId}`);
          if (response.ok) {
            const data = await response.json();
            setStream(data);
          }
        } catch (err) {
          console.error('Failed to refresh stream:', err);
        }
      }

      refetchStream();
    }
  }, [streamEvents, streamId]);

  const handleWithdraw = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    setWithdrawing(true);
    try {
      await withdrawFromStream(session, { streamId: BigInt(streamId) });
      toast.success("Withdrawal successful!");
      // Refresh stream data
      window.location.reload();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setWithdrawing(false);
    }
  };

  const handleCancel = async () => {
    if (!session) {
      toast.error("Please connect your wallet first");
      return;
    }

    if (!confirm("Are you sure you want to cancel this stream?")) {
      return;
    }

    setCancelling(true);
    try {
      await cancelStream(session, { streamId: BigInt(streamId) });
      toast.success("Stream cancelled successfully!");
      // Refresh stream data
      window.location.reload();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setCancelling(false);
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

    try {
      await topUpStream(session, {
        streamId: BigInt(streamId),
        amount: BigInt(parseFloat(topUpAmount) * 1e7), // Convert to stroops
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

  const deposited = parseFloat(stream.depositedAmount) / 1e7;
  const withdrawn = parseFloat(stream.withdrawnAmount) / 1e7;
  const claimable = deposited - withdrawn;
  const percentage = Math.round((withdrawn / deposited) * 100);

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
                Status: {stream.status}
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
                Rate: {(parseFloat(stream.ratePerSecond) / 1e7).toFixed(7)} / sec
              </p>
              <p style={{ margin: "0.2rem 0", fontSize: "0.9rem" }}>
                Started: {new Date(stream.startTime * 1000).toLocaleDateString()}
              </p>
            </div>
          </div>
        </div>

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
          <LiveCounter initial={claimable} label="Available to withdraw" />
        </div>

        {/* Actions */}
        <div className="dashboard-panel">
          <div className="dashboard-panel__header">
            <h3>Actions</h3>
          </div>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <Button
              onClick={handleWithdraw}
              disabled={withdrawing || !stream.isActive || claimable <= 0}
              glow
            >
              {withdrawing ? "Withdrawing..." : "Withdraw"}
            </Button>
            <Button
              onClick={() => setShowTopUp(!showTopUp)}
              disabled={!stream.isActive}
              variant="outline"
            >
              {showTopUp ? "Cancel Top-Up" : "Top Up"}
            </Button>
            <Button
              onClick={handleCancel}
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
    </main>
  );
}