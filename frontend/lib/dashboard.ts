import type { BackendStream, BackendStreamEvent } from "./api-types";

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
  status: "Active" | "Completed" | "Paused" | "Cancelled";
  deposited: number;
  withdrawn: number;
  date: string;
  ratePerSecond: number;
  lastUpdateTime: number;
  isActive: boolean;
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

const STROOPS_DIVISOR = 1e7;

function toTokenAmount(raw: string): number {
  return parseFloat(raw) / STROOPS_DIVISOR;
}

function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getStreamsEndpointCandidates(): string[] {
  const baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const candidates = new Set<string>();

  if (baseUrl.endsWith("/api/v1") || baseUrl.endsWith("/v1")) {
    candidates.add(`${baseUrl}/streams`);
  } else if (baseUrl.endsWith("/api")) {
    candidates.add(`${baseUrl}/v1/streams`);
    candidates.add(`${baseUrl.replace(/\/api$/, "")}/v1/streams`);
  } else {
    candidates.add(`${baseUrl}/api/v1/streams`);
    candidates.add(`${baseUrl}/v1/streams`);
  }

  return [...candidates];
}

async function fetchStreams(
  publicKey: string,
  role: "sender" | "recipient",
): Promise<BackendStream[]> {
  const endpoints = getStreamsEndpointCandidates();
  const params = new URLSearchParams({ [role]: publicKey });
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const response = await fetch(`${endpoint}?${params.toString()}`);
    if (response.ok) {
      return (await response.json()) as BackendStream[];
    }

    if (response.status === 404) {
      lastError = new Error(`Endpoint not found: ${endpoint}`);
      continue;
    }

    lastError = new Error(`Failed to fetch streams (${response.status}) from ${endpoint}`);
  }

  throw lastError ?? new Error("Failed to fetch streams from backend.");
}

/**
 * Maps a backend stream object to the frontend Stream interface.
 */
function mapBackendStreamToFrontend(s: BackendStream, counterparty: string): Stream {
  const deposited = toTokenAmount(s.depositedAmount);
  const withdrawn = toTokenAmount(s.withdrawnAmount);
  const ratePerSecond = toTokenAmount(s.ratePerSecond);

  return {
    id: s.streamId.toString(),
    recipient: shortenAddress(counterparty),
    amount: deposited,
    token: "TOKEN",
    status: s.isActive ? "Active" : "Completed",
    deposited,
    withdrawn,
    date: new Date(s.startTime * 1000).toISOString().split("T")[0],
    ratePerSecond,
    lastUpdateTime: s.lastUpdateTime,
    isActive: s.isActive,
  };
}

/**
 * Fetches dashboard data for a given public key by querying both outgoing and incoming streams.
 */
export async function fetchDashboardData(publicKey: string): Promise<DashboardSnapshot> {
  try {
    const [outgoing, incoming] = await Promise.all([
      fetchStreams(publicKey, "sender"),
      fetchStreams(publicKey, "recipient"),
    ]);

    const outgoingStreams = outgoing.map((stream) =>
      mapBackendStreamToFrontend(stream, stream.recipient),
    );
    const incomingStreams = incoming.map((stream) =>
      mapBackendStreamToFrontend(stream, stream.sender),
    );

    // Aggregation logic
    let totalSent = 0;
    let totalValueLocked = 0;
    let activeStreamsCount = 0;

    outgoing.forEach(s => {
      const dep = toTokenAmount(s.depositedAmount);
      const withdr = toTokenAmount(s.withdrawnAmount);
      totalSent += withdr;
      if (s.isActive) {
        totalValueLocked += (dep - withdr);
        activeStreamsCount++;
      }
    });

    let totalReceived = 0;
    incoming.forEach(s => {
      totalReceived += toTokenAmount(s.withdrawnAmount);
    });

    // Generate recent activity from streams (simplified for now)
    const recentActivity: ActivityItem[] = [
      ...outgoing.map(s => ({
        id: `act-out-${s.id}`,
        title: "Outgoing Stream",
        description: `Stream to ${shortenAddress(s.recipient)}`,
        amount: toTokenAmount(s.depositedAmount),
        direction: "sent" as const,
        timestamp: s.createdAt,
      })),
      ...incoming.map(s => ({
        id: `act-in-${s.id}`,
        title: "Incoming Stream",
        description: `Stream from ${shortenAddress(s.sender)}`,
        amount: toTokenAmount(s.depositedAmount),
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

/**
 * Fetches activity history for a given public key.
 */
export async function fetchUserEvents(publicKey: string): Promise<BackendStreamEvent[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/users/${publicKey}/events`);
    if (!res.ok) {
      throw new Error("Failed to fetch user events from backend.");
    }
    return await res.json();
  } catch (error) {
    console.error("User events fetch error:", error);
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
