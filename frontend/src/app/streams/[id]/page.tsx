"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Pause, Play, X, Plus, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import toast from "react-hot-toast";
import { useWallet } from "@/context/wallet-context";
import { useStreamEvents } from "@/hooks/useStreamEvents";
import {
  withdrawFromStream,
  cancelStream,
  topUpStream,
  pauseStream,
  resumeStream,
  toBaseUnits,
  toSorobanErrorMessage,
} from "@/lib/soroban";
import { CancelConfirmModal } from "@/components/stream-creation/CancelConfirmModal";
import type { BackendStreamEvent } from "@/lib/api-types";
import { formatAmount } from "@/utils/amount";
import { shortenPublicKey } from "@/lib/wallet";

interface StreamDetail {
  id: string;
  streamId: number;
  sender: string;
  recipient: string;
  tokenAddress: string;
  tokenSymbol?: string;
  depositedAmount: string;
  withdrawnAmount: string;
  ratePerSecond: string;
  startTime: number;
  endTime?: number;
  lastUpdateTime: number;
  isActive: boolean;
  status: string;
  isPaused?: boolean;
  pausedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/v1";
const EVENTS_PER_PAGE = 10;

// Token symbol mapping
const TOKEN_SYMBOLS: Record<string, string> = {
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN": "XLM",
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA": "USDC",
  "CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY": "EURC",
};

// Event type styling
const EVENT_STYLES: Record<string, { color: string; icon: string; label: string }> = {
  CREATED: { color: "#22c55e", icon: "✓", label: "Created" },
  TOPPED_UP: { color: "#3b82f6", icon: "+", label: "Topped Up" },
  WITHDRAWN: { color: "#8b5cf6", icon: "↓", label: "Withdrawn" },
  CANCELLED: { color: "#ef4444", icon: "×", label: "Cancelled" },
  COMPLETED: { color: "#10b981", icon: "✓", label: "Completed" },
  PAUSED: { color: "#f59e0b", icon: "⏸", label: "Paused" },
  RESUMED: { color: "#06b6d4", icon: "▶", label: "Resumed" },
  FEE_COLLECTED: { color: "#6b7280", icon: "$", label: "Fee" },
};

export default function StreamDetailsPage() {
  const params = useParams();
  const streamId = params.id as string;
  const { session, isHydrated } = useWallet();

  const [stream, setStream] = useState<StreamDetail | null>(null);
  const [events, setEvents] = useState<BackendStreamEvent[]>([]);
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Action states
  const [withdrawing, setWithdrawing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [showTopUp, setShowTopUp] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);

  // Live claimable counter
  const [liveClaimable, setLiveClaimable] = useState<bigint>(0n);

  // SSE integration
  const { events: streamEvents } = useStreamEvents({
    streamIds: [streamId],
    autoReconnect: true,
  });

  // Fetch stream data
  const fetchStream = useCallback(async () => {
    if (!streamId) return;
    try {
      const response = await fetch(`${API_BASE_URL}/streams/${streamId}`);
      if (!response.ok) throw new Error("Stream not found");
      const data = await response.json();
      setStream(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch stream");
    }
  }, [streamId]);

  // Fetch events
  const fetchEvents = useCallback(async (page: number) => {
    if (!streamId) return;
    try {
      const response = await fetch(
        `${API_BASE_URL}/streams/${streamId}/events?page=${page}&limit=${EVENTS_PER_PAGE}`
      );
      if (response.ok) {
        const data = await response.json();
        setEvents(data.events || []);
        setEventsTotal(data.total || 0);
      }
    } catch (err) {
      console.error("Failed to fetch events:", err);
    }
  }, [streamId]);

  // Initial load
  useEffect(() => {
    if (!isHydrated) return;

    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchStream(), fetchEvents(1)]);
      setLoading(false);
    };

    loadData();
  }, [isHydrated, fetchStream, fetchEvents]);

  // Handle SSE events
  useEffect(() => {
    if (streamEvents.length > 0) {
      fetchStream();
      fetchEvents(eventsPage);
    }
  }, [streamEvents, fetchStream, fetchEvents, eventsPage]);

  // Live claimable counter
  useEffect(() => {
    if (!stream) return;

    const ratePerSecond = BigInt(stream.ratePerSecond);
    const withdrawn = BigInt(stream.withdrawnAmount);
    const deposited = BigInt(stream.depositedAmount);
    const lastUpdate = stream.lastUpdateTime;

    const updateClaimable = () => {
      if (!stream.isActive || stream.isPaused) {
        // Use the server's calculated value when stream is not active
        setLiveClaimable(deposited - withdrawn);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const elapsed = BigInt(now - lastUpdate);
      const accrued = elapsed * ratePerSecond;
      const totalClaimable = deposited - withdrawn + accrued;

      // Cap at deposited amount
      setLiveClaimable(totalClaimable > deposited ? deposited : totalClaimable);
    };

    updateClaimable();
    const interval = setInterval(updateClaimable, 1000);

    return () => clearInterval(interval);
  }, [stream]);

  // User roles
  const isSender = useMemo(() => {
    if (!session || !stream) return false;
    return session.publicKey === stream.sender;
  }, [session, stream]);

  const isRecipient = useMemo(() => {
    if (!session || !stream) return false;
    return session.publicKey === stream.recipient;
  }, [session, stream]);

  // Token symbol
  const tokenSymbol = useMemo(() => {
    if (!stream) return "??";
    return TOKEN_SYMBOLS[stream.tokenAddress] || stream.tokenAddress.slice(0, 4);
  }, [stream]);

  // Handlers
  const handleWithdraw = async () => {
    if (!session) {
      toast.error("Please connect your wallet");
      return;
    }
    setWithdrawing(true);
    try {
      await withdrawFromStream(session, { streamId: BigInt(streamId) });
      toast.success("Withdrawal successful!");
      await fetchStream();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setWithdrawing(false);
    }
  };

  const handleTopUp = async () => {
    if (!session) {
      toast.error("Please connect your wallet");
      return;
    }
    if (!topUpAmount || parseFloat(topUpAmount) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    try {
      const amount = toBaseUnits(topUpAmount);
      await topUpStream(session, { streamId: BigInt(streamId), amount });
      toast.success("Stream topped up successfully!");
      setShowTopUp(false);
      setTopUpAmount("");
      await fetchStream();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    }
  };

  const handlePause = async () => {
    if (!session) {
      toast.error("Please connect your wallet");
      return;
    }
    setPausing(true);
    try {
      await pauseStream(session, { streamId: BigInt(streamId) });
      toast.success("Stream paused");
      await fetchStream();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setPausing(false);
    }
  };

  const handleResume = async () => {
    if (!session) {
      toast.error("Please connect your wallet");
      return;
    }
    setResuming(true);
    try {
      await resumeStream(session, { streamId: BigInt(streamId) });
      toast.success("Stream resumed");
      await fetchStream();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setResuming(false);
    }
  };

  const handleCancel = async () => {
    if (!session) {
      toast.error("Please connect your wallet");
      return;
    }
    setCancelling(true);
    try {
      await cancelStream(session, { streamId: BigInt(streamId) });
      toast.success("Stream cancelled");
      setShowCancelModal(false);
      await fetchStream();
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setCancelling(false);
    }
  };

  const totalPages = Math.ceil(eventsTotal / EVENTS_PER_PAGE);

  if (loading) {
    return (
      <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
        <div className="max-w-4xl mx-auto">
          <div className="glass-card p-8 text-center">
            <div className="animate-spin h-8 w-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-4" />
            <p className="text-slate-400">Loading stream details...</p>
          </div>
        </div>
      </main>
    );
  }

  if (error || !stream) {
    return (
      <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
        <div className="max-w-4xl mx-auto">
          <div className="glass-card p-8 text-center">
            <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <p className="text-red-400 mb-4">{error || "Stream not found"}</p>
            <Link href="/dashboard" className="text-accent hover:underline">
              ← Back to Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const deposited = BigInt(stream.depositedAmount);
  const withdrawn = BigInt(stream.withdrawnAmount);
  const ratePerSecond = BigInt(stream.ratePerSecond);

  return (
    <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard"
            className="p-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <p className="text-sm text-slate-400">Stream #{stream.streamId}</p>
            <h1 className="text-2xl font-bold">Stream Details</h1>
          </div>
          <div className="ml-auto">
            <StatusBadge status={stream.status} isPaused={stream.isPaused} />
          </div>
        </div>

        {/* Stream Overview */}
        <div className="glass-card p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <InfoRow label="Sender" value={shortenPublicKey(stream.sender)} />
              <InfoRow label="Recipient" value={shortenPublicKey(stream.recipient)} />
              <InfoRow label="Token" value={tokenSymbol} />
            </div>
            <div className="space-y-4">
              <InfoRow
                label="Rate"
                value={`${formatAmount(ratePerSecond, 7)} ${tokenSymbol}/sec`}
              />
              <InfoRow
                label="Rate/day"
                value={`${formatAmount(ratePerSecond * 86400n, 7)} ${tokenSymbol}`}
              />
              <InfoRow
                label="Started"
                value={new Date(stream.startTime * 1000).toLocaleString()}
              />
            </div>
          </div>
        </div>

        {/* Financial Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="Total Deposited"
            value={`${formatAmount(deposited, 7)} ${tokenSymbol}`}
          />
          <StatCard
            label="Withdrawn"
            value={`${formatAmount(withdrawn, 7)} ${tokenSymbol}`}
          />
          <StatCard
            label="Claimable"
            value={`${formatAmount(liveClaimable, 7)} ${tokenSymbol}`}
            highlight
            live
          />
        </div>

        {/* Progress */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold mb-4">Stream Progress</h3>
          <div className="h-3 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent to-accent/70 transition-all duration-500"
              style={{
                width: `${Math.min(100, Number((withdrawn * 100n) / deposited))}%`,
              }}
            />
          </div>
          <p className="text-sm text-slate-400 mt-2">
            {formatAmount(withdrawn, 7)} / {formatAmount(deposited, 7)} {tokenSymbol} withdrawn
          </p>
        </div>

        {/* Actions */}
        {(isSender || isRecipient) && stream.isActive && (
          <div className="glass-card p-6">
            <h3 className="text-lg font-semibold mb-4">Actions</h3>
            <div className="flex flex-wrap gap-3">
              {/* Recipient: Withdraw */}
              {isRecipient && (
                <Button
                  onClick={handleWithdraw}
                  disabled={withdrawing || liveClaimable <= 0n}
                  glow
                  className="flex items-center gap-2"
                >
                  <Download className="h-4 w-4" />
                  {withdrawing ? "Withdrawing..." : "Withdraw"}
                </Button>
              )}

              {/* Sender: Top Up */}
              {isSender && (
                <Button
                  onClick={() => setShowTopUp(!showTopUp)}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  {showTopUp ? "Cancel" : "Top Up"}
                </Button>
              )}

              {/* Sender: Pause/Resume */}
              {isSender && (
                <>
                  {!stream.isPaused ? (
                    <Button
                      onClick={handlePause}
                      disabled={pausing}
                      variant="outline"
                      className="flex items-center gap-2"
                    >
                      <Pause className="h-4 w-4" />
                      {pausing ? "Pausing..." : "Pause"}
                    </Button>
                  ) : (
                    <Button
                      onClick={handleResume}
                      disabled={resuming}
                      variant="outline"
                      className="flex items-center gap-2"
                    >
                      <Play className="h-4 w-4" />
                      {resuming ? "Resuming..." : "Resume"}
                    </Button>
                  )}
                </>
              )}

              {/* Sender: Cancel */}
              {isSender && (
                <Button
                  onClick={() => setShowCancelModal(true)}
                  disabled={cancelling}
                  variant="outline"
                  className="flex items-center gap-2 border-red-500/50 text-red-400 hover:bg-red-500/10"
                >
                  <X className="h-4 w-4" />
                  Cancel
                </Button>
              )}
            </div>

            {/* Top Up Input */}
            {showTopUp && (
              <div className="mt-4 flex gap-2">
                <input
                  type="number"
                  placeholder={`Amount in ${tokenSymbol}`}
                  value={topUpAmount}
                  onChange={(e) => setTopUpAmount(e.target.value)}
                  className="flex-1 px-4 py-2 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
                />
                <Button onClick={handleTopUp}>Add Funds</Button>
              </div>
            )}
          </div>
        )}

        {/* Event History */}
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold mb-4">Event History</h3>

          {events.length === 0 ? (
            <p className="text-slate-400 text-center py-8">No events yet</p>
          ) : (
            <>
              <div className="space-y-3">
                {events.map((event) => (
                  <EventRow key={event.id} event={event} tokenSymbol={tokenSymbol} />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/10">
                  <button
                    onClick={() => {
                      const newPage = eventsPage - 1;
                      setEventsPage(newPage);
                      fetchEvents(newPage);
                    }}
                    disabled={eventsPage === 1}
                    className="px-3 py-1 text-sm rounded-lg border border-white/10 disabled:opacity-50 hover:border-accent transition-colors"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-slate-400">
                    Page {eventsPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => {
                      const newPage = eventsPage + 1;
                      setEventsPage(newPage);
                      fetchEvents(newPage);
                    }}
                    disabled={eventsPage === totalPages}
                    className="px-3 py-1 text-sm rounded-lg border border-white/10 disabled:opacity-50 hover:border-accent transition-colors"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Cancel Confirmation Modal */}
      {showCancelModal && stream && (
        <CancelConfirmModal
          streamId={streamId}
          recipient={shortenPublicKey(stream.recipient)}
          token={tokenSymbol}
          deposited={Number(formatAmount(deposited, 7))}
          withdrawn={Number(formatAmount(withdrawn, 7))}
          onConfirm={handleCancel}
          onClose={() => setShowCancelModal(false)}
        />
      )}
    </main>
  );
}

// Helper Components
function StatusBadge({ status, isPaused }: { status: string; isPaused?: boolean }) {
  const getStyles = () => {
    if (isPaused) return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    switch (status.toLowerCase()) {
      case "active":
        return "bg-green-500/20 text-green-400 border-green-500/30";
      case "completed":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "cancelled":
        return "bg-red-500/20 text-red-400 border-red-500/30";
      default:
        return "bg-slate-500/20 text-slate-400 border-slate-500/30";
    }
  };

  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium border ${getStyles()}`}>
      {isPaused ? "Paused" : status}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  live,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  live?: boolean;
}) {
  return (
    <div
      className={`glass-card p-4 ${highlight ? "border-accent/30 bg-accent/5" : ""}`}
    >
      <p className="text-slate-400 text-sm mb-1">{label}</p>
      <p className={`text-lg font-bold ${live ? "text-accent" : ""}`}>
        {value}
        {live && <span className="ml-2 text-xs animate-pulse">●</span>}
      </p>
    </div>
  );
}

function EventRow({
  event,
  tokenSymbol,
}: {
  event: BackendStreamEvent;
  tokenSymbol: string;
}) {
  const style = EVENT_STYLES[event.eventType] || {
    color: "#6b7280",
    icon: "•",
    label: event.eventType,
  };

  return (
    <div className="flex items-center gap-4 py-3 border-b border-white/5 last:border-0">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
        style={{ backgroundColor: `${style.color}20`, color: style.color }}
      >
        {style.icon}
      </div>
      <div className="flex-1">
        <p className="font-medium">{style.label}</p>
        <p className="text-sm text-slate-400">
          {new Date(event.timestamp * 1000).toLocaleString()}
        </p>
      </div>
      {event.amount && (
        <div className="text-right">
          <p className="font-mono">
            {formatAmount(BigInt(event.amount), 7)} {tokenSymbol}
          </p>
        </div>
      )}
    </div>
  );
}