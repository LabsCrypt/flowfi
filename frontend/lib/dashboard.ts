import type { BackendStream } from "./api-types";

export interface ActivityItem {
  id: string;
  title: string;
  description: string;
  amount: number;
  direction: "sent" | "received";
  timestamp: string;
}

export interface Stream {
  id: string;
  recipient: string;
  amount: number;
  token: string;
  status: "Active" | "Completed" | "Paused";
  deposited: number;
  withdrawn: number;
  date: string;
}

export interface DashboardSnapshot {
  totalSent: number;
  totalReceived: number;
  totalValueLocked: number;
  activeStreamsCount: number;
  recentActivity: ActivityItem[];
  outgoingStreams: Stream[];
  incomingStreams: Stream[];
}

export interface DashboardAnalyticsMetric {
  id: string;
  label: string;
  detail: string;
  format: "currency" | "percent";
  value: number | null;
  unavailableText: string;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/v1";

/**
 * Maps a backend stream object to the frontend Stream interface.
 */
function mapBackendStreamToFrontend(s: BackendStream): Stream {
  const deposited = parseFloat(s.depositedAmount) / 1e7; // Assuming 7 decimals for now, should ideally come from token config
  const withdrawn = parseFloat(s.withdrawnAmount) / 1e7;

  return {
    id: s.streamId.toString(),
    recipient: s.recipient.slice(0, 4) + "..." + s.recipient.slice(-4),
    amount: deposited,
    token: "TOKEN", // We don't have token symbols from backend yet
    status: s.isActive ? "Active" : "Completed",
    deposited,
    withdrawn,
    date: new Date(s.startTime * 1000).toISOString().split("T")[0],
  };
}

/**
 * Fetches dashboard data for a given public key by querying both outgoing and incoming streams.
 */
export async function fetchDashboardData(publicKey: string): Promise<DashboardSnapshot> {
  try {
    const [outgoingRes, incomingRes] = await Promise.all([
      fetch(`${API_BASE_URL}/streams?sender=${publicKey}`),
      fetch(`${API_BASE_URL}/streams?recipient=${publicKey}`),
    ]);

    if (!outgoingRes.ok || !incomingRes.ok) {
      throw new Error("Failed to fetch streams from backend.");
    }

    const outgoing: BackendStream[] = await outgoingRes.json();
    const incoming: BackendStream[] = await incomingRes.json();

    const outgoingStreams = outgoing.map(mapBackendStreamToFrontend);
    const incomingStreams = incoming.map(mapBackendStreamToFrontend);

    // Aggregation logic
    let totalSent = 0;
    let totalValueLocked = 0;
    let activeStreamsCount = 0;

    outgoing.forEach(s => {
      const dep = parseFloat(s.depositedAmount) / 1e7;
      const withdr = parseFloat(s.withdrawnAmount) / 1e7;
      totalSent += withdr;
      if (s.isActive) {
        totalValueLocked += (dep - withdr);
        activeStreamsCount++;
      }
    });

    let totalReceived = 0;
    incoming.forEach(s => {
      totalReceived += parseFloat(s.withdrawnAmount) / 1e7;
    });

    // Generate recent activity from streams (simplified for now)
    const recentActivity: ActivityItem[] = [
      ...outgoing.map(s => ({
        id: `act-out-${s.id}`,
        title: "Outgoing Stream",
        description: `Stream to ${s.recipient.slice(0, 6)}...`,
        amount: parseFloat(s.depositedAmount) / 1e7,
        direction: "sent" as const,
        timestamp: s.createdAt,
      })),
      ...incoming.map(s => ({
        id: `act-in-${s.id}`,
        title: "Incoming Stream",
        description: `Stream from ${s.sender.slice(0, 6)}...`,
        amount: parseFloat(s.depositedAmount) / 1e7,
        direction: "received" as const,
        timestamp: s.createdAt,
      })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);

    return {
      totalSent,
      totalReceived,
      totalValueLocked,
      activeStreamsCount,
      recentActivity,
      outgoingStreams,
      incomingStreams,
    };
  } catch (error) {
    console.error("Dashboard data fetch error:", error);
    throw error;
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function getDashboardAnalytics(
  snapshot: DashboardSnapshot | null,
): DashboardAnalyticsMetric[] {
  if (!snapshot) {
    return [
      {
        id: "total-volume-30d",
        label: "Total Volume (30D)",
        detail: "Total throughput in the last 30 days",
        format: "currency",
        value: null,
        unavailableText: "Insufficient historical data",
      },
      {
        id: "net-flow-30d",
        label: "Net Flow (30D)",
        detail: "Net capital flow over the last 30 days",
        format: "currency",
        value: null,
        unavailableText: "Insufficient historical data",
      },
      {
        id: "avg-value-per-stream",
        label: "Avg Value / Stream",
        detail: "Mean capital locked across active streams",
        format: "currency",
        value: null,
        unavailableText: "No active streams",
      },
      {
        id: "stream-utilization",
        label: "Stream Utilization",
        detail: "Share of total capital already withdrawn",
        format: "percent",
        value: null,
        unavailableText: "No withdrawal data",
      },
    ];
  }

  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const recentActivity = snapshot.recentActivity.filter((item) => {
    const parsed = Date.parse(item.timestamp);
    return Number.isFinite(parsed) && parsed >= cutoff;
  });

  const incoming30d = recentActivity
    .filter((item) => item.direction === "received")
    .reduce((sum, item) => sum + item.amount, 0);

  const outgoing30d = recentActivity
    .filter((item) => item.direction === "sent")
    .reduce((sum, item) => sum + item.amount, 0);

  const totalVolume30d = incoming30d + outgoing30d;
  const netFlow30d = incoming30d - outgoing30d;
  const avgValuePerStream =
    snapshot.activeStreamsCount > 0
      ? snapshot.totalValueLocked / snapshot.activeStreamsCount
      : null;

  const totalDeposited = [
    ...snapshot.outgoingStreams,
    ...snapshot.incomingStreams,
  ].reduce((sum, stream) => sum + stream.deposited, 0);

  const totalWithdrawn = [
    ...snapshot.outgoingStreams,
    ...snapshot.incomingStreams,
  ].reduce((sum, stream) => sum + stream.withdrawn, 0);

  const utilization = totalDeposited > 0 ? totalWithdrawn / totalDeposited : null;

  return [
    {
      id: "total-volume-30d",
      label: "Total Volume (30D)",
      detail: "Total throughput in the last 30 days",
      format: "currency",
      value: totalVolume30d,
      unavailableText: "Insufficient historical data",
    },
    {
      id: "net-flow-30d",
      label: "Net Flow (30D)",
      detail: "Net capital flow over the last 30 days",
      format: "currency",
      value: netFlow30d,
      unavailableText: "Insufficient historical data",
    },
    {
      id: "avg-value-per-stream",
      label: "Avg Value / Stream",
      detail: "Mean capital locked across active streams",
      format: "currency",
      value: avgValuePerStream,
      unavailableText: "No active streams",
    },
    {
      id: "stream-utilization",
      label: "Stream Utilization",
      detail: "Share of total capital already withdrawn",
      format: "percent",
      value: utilization,
      unavailableText: "No withdrawal data",
    },
  ];
}
