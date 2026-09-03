"use client";

import React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import toast from "react-hot-toast";

/**
 * components/dashboard/dashboard-view.tsx
 *
 * Changes:
 *  - Skeleton shimmer cards while GET /v1/streams is fetching (3 placeholder cards)
 *  - Empty state for no outgoing streams: illustration + "Create your first stream" CTA
 *  - Empty state for no incoming streams: "No streams are sending you funds yet"
 *  - Empty state for the activity tab: "No stream activity yet"
 *  - Error state: "Failed to load streams" with a retry button
 */

import {
  getDashboardAnalytics,
  useDashboard,
  dashboardQueryKey,
  type DashboardSnapshot,
  type Stream,
} from "@/lib/dashboard";
import {
  shortenPublicKey,
  formatNetwork,
  isExpectedNetwork,
  type WalletSession,
} from "@/lib/wallet";
import {
  createStream as sorobanCreateStream,
  topUpStream as sorobanTopUp,
  cancelStream as sorobanCancel,
  withdrawFromStream as sorobanWithdraw,
  toBaseUnits,
  toDurationSeconds,
  getTokenAddress,
  toSorobanErrorMessage,
} from "@/lib/soroban";
import { useStreamEvents } from "@/hooks/useStreamEvents";
import { SSEStatusIndicator } from "./SSEStatusIndicator";
import {
  StreamCreationWizard,
  type StreamFormData,
} from "../stream-creation/StreamCreationWizard";
import { TopUpModal } from "../stream-creation/TopUpModal";
import { useQueryClient } from "@tanstack/react-query";
import { CancelConfirmModal } from "../stream-creation/CancelConfirmModal";
import { StreamDetailsModal } from "./StreamDetailsModal";
import { Button } from "../ui/Button";

// @ts-expect-error unused var
const DashboardOverviewDynamic = dynamic(
  () => import("./DashboardOverview").then((m) => m.DashboardOverview),
  { ssr: false },
);
const DashboardIncomingDynamic = dynamic(
  () => import("./DashboardIncoming").then((m) => m.DashboardIncoming),
  { ssr: false },
);
const DashboardOutgoingDynamic = dynamic(
  () => import("./DashboardOutgoing").then((m) => m.DashboardOutgoing),
  { ssr: false },
);
const DashboardPausedDynamic = dynamic(
  () => import("./DashboardPaused").then((m) => m.DashboardPaused),
  { ssr: false },
);
const DashboardActivityDynamic = dynamic(
  () => import("./DashboardActivity").then((m) => m.DashboardActivity),
  { ssr: false },
);
const DashboardSettingsDynamic = dynamic(
  () => import("./DashboardSettings").then((m) => m.DashboardSettings),
  { ssr: false },
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardViewProps {
  session: WalletSession;
  onDisconnect: () => void;
}

interface SidebarItem {
  id: string;
  label: string;
}

type ModalState =
  | null
  | { type: "topup"; stream: Stream }
  | { type: "cancel"; stream: Stream }
  | { type: "details"; stream: Stream };

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "overview", label: "Overview" },
  { id: "incoming", label: "Incoming" },
  { id: "outgoing", label: "Outgoing" },
  { id: "paused", label: "Paused" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

// ─── Skeleton & Empty State Components ───────────────────────────────────────

/** Shimmer card used as a placeholder while data loads */
function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl ${className}`}
      aria-hidden="true"
    >
      {/* shimmer sweep */}
      <div className="absolute inset-0 -translate-x-full motion-reduce:animate-none bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </div>
  );
}

/** Three stat cards + one table skeleton rendered while the API call is in-flight */
function DashboardSkeleton() {
  return (
    <div
      className="mt-8 space-y-6"
      aria-label="Loading dashboard…"
      role="status"
    >
      {/* stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <SkeletonCard className="h-32" />
        <SkeletonCard className="h-32" />
        <SkeletonCard className="h-32" />
      </div>
      {/* analytics strip */}
      <SkeletonCard className="h-40" />
      {/* streams table */}
      <SkeletonCard className="h-72" />
      {/* activity list */}
      <SkeletonCard className="h-48" />
    </div>
  );
}

/** Generic empty state with an optional CTE */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col items-center justify-center p-12 glass-card rounded-3xl border-slate-800 text-center mt-8">
      <div className="h-20 w-20 rounded-full bg-accent/10 flex items-center justify-center mb-6">
        {icon}
      </div>
      <h2 className="text-2xl font-bold mb-2">{title}</h2>
      <p className="text-slate-400 max-w-md mb-8">{description}</p>
      {action}
    </section>
  );
}

/** Shown when the API call to /v1/streams fails */
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="mt-8">
      <div className="p-8 rounded-2xl bg-red-500/10 border border-red-500/20 text-center">
        <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
          <svg
            className="h-8 w-8 text-red-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-red-400">
          Failed to load streams
        </h2>
        <p className="text-slate-400 mt-2 mb-6">{message}</p>
        <Button onClick={onRetry} variant="ghost">
          Retry
        </Button>
      </div>
    </section>
  );
}

// ─── Icon helpers ─────────────────────────────────────────────────────────────

export function BoltIcon() {
  return (
    <svg
      className="h-10 w-10 text-accent"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  );
}

export function InboxIcon() {
  return (
    <svg
      className="h-10 w-10 text-accent"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M20 13V7a2 2 0 00-2-2H6a2 2 0 00-2 2v6m16 0l-2 4H6l-2-4m16 0H4"
      />
    </svg>
  );
}

export function ActivityIcon() {
  return (
    <svg
      className="h-10 w-10 text-accent"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
      />
    </svg>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatAnalyticsValue(
  value: number,
  format: "currency" | "percent",
): string {
  if (format === "currency") return formatCurrency(value);
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function renderStats(snapshot: DashboardSnapshot | null) {
  if (!snapshot) return null;
  return (
    <div className="dashboard-stats-grid">
      <div className="dashboard-panel">
        <h3>Total Sent</h3>
        <p className="text-2xl font-bold">
          {formatCurrency(snapshot.totalSent)}
        </p>
      </div>
      <div className="dashboard-panel">
        <h3>Total Received</h3>
        <p className="text-2xl font-bold">
          {formatCurrency(snapshot.totalReceived)}
        </p>
      </div>
      <div className="dashboard-panel">
        <h3>Total Value Locked</h3>
        <p className="text-2xl font-bold">
          {formatCurrency(snapshot.totalValueLocked)}
        </p>
      </div>
    </div>
  );
}

function renderAnalytics(snapshot: DashboardSnapshot | null) {
  const metrics = getDashboardAnalytics(snapshot);
  return (
    <section
      className="dashboard-analytics-section"
      aria-label="Analytics overview"
    >
      <div className="dashboard-panel__header">
        <h3>Analytics Overview</h3>
        <span>Computed from wallet activity</span>
      </div>
      <div className="dashboard-analytics-grid">
        {metrics.map((metric) => {
          const isUnavailable = metric.value === null;
          return (
            <article
              key={metric.id}
              className="dashboard-analytics-card"
              data-unavailable={isUnavailable ? "true" : undefined}
            >
              <p>{metric.label}</p>
              <h2>
                {isUnavailable ? "No data" : formatAnalyticsValue(metric.value!, metric.format)}
              </h2>
              <span>
                {isUnavailable ? "No data" : metric.detail}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

const StreamsTable = React.memo(function StreamsTable({
  snapshot,
  onTopUp,
  onCancel,
  onShowDetails,
}: {
  snapshot: DashboardSnapshot | null;
  onTopUp: (stream: Stream) => void;
  onCancel: (stream: Stream) => void;
  onShowDetails: (stream: Stream) => void;
}) {
  if (!snapshot) return null;
  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel__header">
        <h3>My Active Streams</h3>
        <span>
          {snapshot.outgoingStreams.filter((s) => s.status === "Active").length}{" "}
          total
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Recipient</th>
              <th>Deposited</th>
              <th>Withdrawn</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.outgoingStreams
              .filter((s) => s.status === "Active")
              .map((stream) => (
                <tr
                  key={stream.id}
                  className="cursor-pointer hover:bg-white/5"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button")) return;
                    onShowDetails(stream);
                  }}
                >
                  <td>{stream.date}</td>
                  <td>
                    <code className="text-xs">{stream.recipient}</code>
                  </td>
                  <td className="font-semibold text-accent">
                    {stream.deposited} {stream.token}
                  </td>
                  <td className="text-slate-400">
                    {stream.withdrawn} {stream.token}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/^\d+$/.test(stream.id) ? (
                        <Link
                          href={`/app/streams/${stream.id}`}
                          className="secondary-button py-1 px-3 text-sm h-auto inline-flex items-center"
                        >
                          Details
                        </Link>
                      ) : null}
                      <button
                        type="button"
                        className="secondary-button py-1 px-3 text-sm h-auto"
                        onClick={() => onTopUp(stream)}
                      >
                        Add Funds
                      </button>
                      <button
                        type="button"
                        className="py-1 px-3 text-sm rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors font-semibold"
                        onClick={() => onCancel(stream)}
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
});

const RecentActivityList = React.memo(function RecentActivityList({
  snapshot,
  onCreateStream,
}: {
  snapshot: DashboardSnapshot | null;
  onCreateStream?: () => void;
}) {
  if (!snapshot) return null;

  if (snapshot.recentActivity.length === 0) {
    return (
      <EmptyState
        icon={<ActivityIcon />}
        title="No stream activity yet"
        description="Transactions will appear here once you start creating or receiving payment streams."
        action={
          onCreateStream ? (
            <Button onClick={onCreateStream} variant="ghost">
              Create a Stream
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel__header">
        <h3>Recent Activity</h3>
        <span>{snapshot.recentActivity.length} items</span>
      </div>
      <ul className="activity-list">
        {snapshot.recentActivity.map((activity) => {
          const amountPrefix = activity.direction === "received" ? "+" : "-";
          const amountClass =
            activity.direction === "received" ? "is-positive" : "is-negative";
          return (
            <li key={activity.id} className="activity-item">
              <div>
                <strong>{activity.title}</strong>
                <p>{activity.description}</p>
                <small>{formatActivityTime(activity.timestamp)}</small>
              </div>
              <span className={amountClass}>
                {amountPrefix}
                {formatCurrency(activity.amount)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
});

// ─── Main Component ───────────────────────────────────────────────────────────

const VALID_TAB_IDS = new Set(SIDEBAR_ITEMS.map((item) => item.id));

export function DashboardView({ session, onDisconnect }: DashboardViewProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab = VALID_TAB_IDS.has(tabParam ?? "") ? (tabParam as string) : "overview";
  const [showWizard, setShowWizard] = React.useState(false);
  const [modal, setModal] = React.useState<ModalState>(null);

  const {
    data: snapshotData,
    isLoading: isSnapshotLoading,
    isError: isSnapshotError,
    error: snapshotErrorObj,
    refetch: refetchSnapshot,
  } = useDashboard(session.publicKey);

  const snapshot: DashboardSnapshot | null = snapshotData ?? null;
  const snapshotError = isSnapshotError
    ? snapshotErrorObj instanceof Error
      ? snapshotErrorObj.message
      : "Failed to fetch dashboard data."
    : null;

  const {
    events: streamEvents,
    connected,
    reconnecting,
    error,
  } = useStreamEvents({
    userPublicKeys: [session.publicKey],
    autoReconnect: true,
  });

  React.useEffect(() => {
    if (streamEvents.length > 0) {
      const latestEvent = streamEvents[0];
      if (latestEvent) {
        const relevantTypes = [
          "created",
          "topped_up",
          "withdrawn",
          "cancelled",
          "completed",
          "paused",
          "resumed",
        ];
        if (relevantTypes.includes(latestEvent.type)) {
          void queryClient.invalidateQueries({
            queryKey: dashboardQueryKey(session.publicKey),
          });
        }
      }
    }
  }, [streamEvents, session.publicKey, queryClient]);

  const [withdrawingIncomingStreamId, setWithdrawingIncomingStreamId] =
    React.useState<string | null>(null);

  const handleTopUp = React.useCallback(
    (s: Stream) => setModal({ type: "topup", stream: s }),
    [],
  );
  const handleCancel = React.useCallback(
    (s: Stream) => setModal({ type: "cancel", stream: s }),
    [],
  );
  const handleShowDetails = React.useCallback(
    (s: Stream) => setModal({ type: "details", stream: s }),
    [],
  );
  const handleShowWizard = React.useCallback(
    () => setShowWizard(true),
    [],
  );

  // ── Optimistic helpers ─────────────────────────────────────────────────────

  const removeStreamLocally = (streamId: string) => {
    queryClient.setQueryData<DashboardSnapshot | undefined>(dashboardQueryKey(session.publicKey), (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        outgoingStreams: prev.outgoingStreams.map((s) =>
          s.id === streamId
            ? { ...s, status: "Cancelled", isActive: false }
            : s,
        ),
        activeStreamsCount: Math.max(0, prev.activeStreamsCount - 1),
      };
    });
  };

  const topUpStreamLocally = (streamId: string, amount: number) => {
    queryClient.setQueryData<DashboardSnapshot | undefined>(
      dashboardQueryKey(session.publicKey),
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          outgoingStreams: prev.outgoingStreams.map((s) =>
            s.id === streamId ? { ...s, deposited: s.deposited + amount } : s,
          ),
        };
      },
    );
  };

  const addStreamLocally = (data: StreamFormData) => {
    const newStream: Stream = {
      id: `stream-${Date.now()}`,
      date: new Date().toISOString().split("T")[0] ?? "",
      recipient: shortenPublicKey(data.recipient),
      amount: parseFloat(data.amount),
      token: data.token,
      status: "Active",
      deposited: parseFloat(data.amount),
      withdrawn: 0,
      ratePerSecond: 0,
      lastUpdateTime: Math.floor(Date.now() / 1000),
      isActive: true,
    };
    queryClient.setQueryData<DashboardSnapshot | undefined>(
      dashboardQueryKey(session.publicKey),
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          outgoingStreams: [newStream, ...prev.outgoingStreams],
          activeStreamsCount: prev.activeStreamsCount + 1,
        };
      },
    );
  };

  // ── Contract handlers ─────────────────────────────────────────────────────

  const handleCreateStream = async (data: StreamFormData) => {
    const toastId = toast.loading("Creating stream…");
    try {
      const result = await sorobanCreateStream(session, {
        recipient: data.recipient,
        tokenAddress: getTokenAddress(data.token),
        amount: toBaseUnits(data.amount),
        durationSeconds: toDurationSeconds(data.duration, data.durationUnit),
      });
      addStreamLocally(data);
      // We don't call setShowWizard(false) here anymore, the wizard handles its own flow
      toast.success("Transaction confirmed on-chain!", { id: toastId });
      return result;
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  const handleTopUpConfirm = async (streamId: string, amountStr: string) => {
    const toastId = toast.loading("Topping up stream…");
    try {
      await sorobanTopUp(session, {
        streamId: BigInt(streamId.replace(/\D/g, "") || "0"),
        amount: toBaseUnits(amountStr),
      });
      topUpStreamLocally(streamId, parseFloat(amountStr));
      setModal(null);
      toast.success("Stream topped up successfully!", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  const handleCancelConfirm = async (streamId: string) => {
    const toastId = toast.loading("Cancelling stream…");
    try {
      await sorobanCancel(session, {
        streamId: BigInt(streamId.replace(/\D/g, "") || "0"),
      });
      removeStreamLocally(streamId);
      setModal(null);
      toast.success("Stream cancelled.", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  const handleIncomingWithdraw = async (stream: Stream) => {
    const toastId = toast.loading("Withdrawing stream funds…");
    setWithdrawingIncomingStreamId(stream.id);
    try {
      await sorobanWithdraw(session, {
        streamId: BigInt(stream.id.replace(/\D/g, "") || "0"),
      });
      await refetchSnapshot();
      toast.success("Withdrawal successful!", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    } finally {
      setWithdrawingIncomingStreamId(null);
    }
  };


  // ── Tab content ───────────────────────────────────────────────────────────

  const renderContent = () => {
    // ── Loading state ─────────────────────────────────────────────────────
    if (isSnapshotLoading) {
      return <DashboardSkeleton />;
    }

    // ── Error state ───────────────────────────────────────────────────────
    if (snapshotError) {
      return (
        <ErrorState
          message={snapshotError}
          onRetry={() => void refetchSnapshot()}
        />
      );
    }

    // ── First-time / completely empty wallet ──────────────────────────────
    const hasNoStreams =
      !snapshot ||
      (snapshot.outgoingStreams.length === 0 &&
        snapshot.incomingStreams.length === 0);

    if (hasNoStreams) {
      return (
        <EmptyState
          icon={<BoltIcon />}
          title="Start your first stream"
          description="You haven't created or received any payment streams yet. Connect with others and start streaming tokens in real-time."
          action={
            <Button onClick={() => setShowWizard(true)} glow size="lg">
              Create Stream
            </Button>
          }
        />
      );
    }

    // ── Overview (default tab, rendered synchronously) ─────────────────────
    if (activeTab === "overview") {
      return (
        <div className="dashboard-content-stack mt-8">
          {renderStats(snapshot)}
          {renderAnalytics(snapshot)}
          <StreamsTable
            snapshot={snapshot}
            onTopUp={handleTopUp}
            onCancel={handleCancel}
            onShowDetails={handleShowDetails}
          />
          <RecentActivityList snapshot={snapshot} onCreateStream={handleShowWizard} />
        </div>
      );
    }

    // Pass required props to each tab component
    if (activeTab === "incoming") {
      return (
        <DashboardIncomingDynamic
          incomingStreams={snapshot!.incomingStreams}
          onWithdraw={handleIncomingWithdraw}
          withdrawingStreamId={withdrawingIncomingStreamId}
        />
      );
    }

    if (activeTab === "outgoing") {
      return (
        <DashboardOutgoingDynamic
          outgoingStreams={snapshot!.outgoingStreams}
          onTopUp={(s) => setModal({ type: "topup", stream: s })}
          onCancel={(s) => setModal({ type: "cancel", stream: s })}
          onShowDetails={(s) => setModal({ type: "details", stream: s })}
          setShowWizard={() => setShowWizard(true)}
        />
      );
    }

    if (activeTab === "paused") {
      return (
        <DashboardPausedDynamic
          outgoingStreams={snapshot!.outgoingStreams}
          incomingStreams={snapshot!.incomingStreams}
        />
      );
    }

    if (activeTab === "activity") {
      return (
        <DashboardActivityDynamic
          recentActivity={snapshot!.recentActivity}
          onCreateStream={() => setShowWizard(true)}
        />
      );
    }

    if (activeTab === "settings") {
      return (
        <DashboardSettingsDynamic
          session={session}
          onDisconnect={onDisconnect}
        />
      );
    }

    return (
      <div className="dashboard-empty-state mt-8">
        <h2>Under Construction</h2>
        <p>This tab is currently under development.</p>
      </div>
    );
  };

  const networkLabel = formatNetwork(session.network);
  const networkOk = isExpectedNetwork(session.network);

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="brand">FlowFi</div>
        <nav aria-label="Sidebar">
          {SIDEBAR_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="sidebar-item"
              data-active={activeTab === item.id ? "true" : undefined}
              aria-current={activeTab === item.id ? "page" : undefined}
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("tab", item.id);
                router.replace(`?${params.toString()}`);
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="kicker">Dashboard</p>
            <h1>
              {SIDEBAR_ITEMS.find((item) => item.id === activeTab)?.label}
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <SSEStatusIndicator
              connected={connected}
              reconnecting={reconnecting}
              error={error}
            />
            <Button onClick={() => setShowWizard(true)} glow>
              Create Stream
            </Button>
            <div className="wallet-chip" title={session.publicKey}>
              <span className="wallet-chip__name">{session.walletName}</span>
              <span
                className="wallet-chip__network"
                data-mainnet={networkLabel === "Mainnet" ? "true" : undefined}
                data-mismatch={!networkOk ? "true" : undefined}
              >
                {networkLabel}
              </span>
              <span className="wallet-chip__key">
                {shortenPublicKey(session.publicKey)}
              </span>
            </div>
          </div>
        </header>

        {renderContent()}

        <div className="dashboard-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onDisconnect}
          >
            Disconnect Wallet
          </button>
        </div>
      </section>

      {showWizard && (
        <StreamCreationWizard
          onClose={() => setShowWizard(false)}
          onSubmit={handleCreateStream}
          walletPublicKey={session.publicKey}
        />
      )}
      {modal?.type === "topup" && (
        <TopUpModal
          streamId={modal.stream.id}
          token={modal.stream.token}
          currentDeposited={modal.stream.deposited}
          onConfirm={handleTopUpConfirm}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "cancel" && (
        <CancelConfirmModal
          streamId={modal.stream.id}
          recipient={modal.stream.recipient}
          token={modal.stream.token}
          deposited={modal.stream.deposited}
          withdrawn={modal.stream.withdrawn}
          onConfirm={handleCancelConfirm}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "details" && (
        <StreamDetailsModal
          stream={modal.stream}
          onClose={() => setModal(null)}
          onCancelClick={() =>
            setModal({ type: "cancel", stream: modal.stream })
          }
          onTopUpClick={() => setModal({ type: "topup", stream: modal.stream })}
        />
      )}
    </main>
  );
}