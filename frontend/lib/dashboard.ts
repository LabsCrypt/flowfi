import type { WalletId } from "@/lib/wallet";

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
  status: "Active" | "Completed" | "Cancelled";
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
  streams: Stream[];
}

export interface DashboardAnalyticsMetric {
  id: string;
  label: string;
  detail: string;
  format: "currency" | "percent";
  value: number | null;
  unavailableText: string;
}

const MOCK_STATS_BY_WALLET: Record<WalletId, DashboardSnapshot | null> = {
  freighter: {
    totalSent: 12850,
    totalReceived: 4720,
    totalValueLocked: 32140,
    activeStreamsCount: 2,
    streams: [
      {
        id: "stream-1",
        date: "2023-10-25",
        recipient: "G...ABCD",
        amount: 500,
        token: "USDC",
        status: "Active",
        deposited: 500,
        withdrawn: 100,
      },
      {
        id: "stream-2",
        date: "2023-10-26",
        recipient: "G...EFGH",
        amount: 1200,
        token: "XLM",
        status: "Active",
        deposited: 1200,
        withdrawn: 300,
      },
    ],
    recentActivity: [
      {
        id: "act-1",
        title: "Design Retainer",
        description: "Outgoing stream settled",
        amount: 250,
        direction: "sent",
        timestamp: "2026-02-19T13:10:00.000Z",
      },
      {
        id: "act-2",
        title: "Community Grant",
        description: "Incoming stream payout",
        amount: 420,
        direction: "received",
        timestamp: "2026-02-18T17:45:00.000Z",
      },
      {
        id: "act-3",
        title: "Developer Subscription",
        description: "Outgoing recurring payment",
        amount: 85,
        direction: "sent",
        timestamp: "2026-02-18T09:15:00.000Z",
      },
    ],
  },
  albedo: null,
  xbull: {
    totalSent: 2130,
    totalReceived: 3890,
    totalValueLocked: 5400,
    activeStreamsCount: 1,
    streams: [
      {
        id: "stream-3",
        date: "2023-10-27",
        recipient: "G...IJKL",
        amount: 300,
        token: "EURC",
        status: "Active",
        deposited: 300,
        withdrawn: 50,
      },
    ],
    recentActivity: [
      {
        id: "act-4",
        title: "Ops Payroll",
        description: "Incoming stream payout",
        amount: 630,
        direction: "received",
        timestamp: "2026-02-19T08:05:00.000Z",
      },
    ],
  },
};

export function getMockDashboardStats(
  walletId: WalletId,
): DashboardSnapshot | null {
  const source = MOCK_STATS_BY_WALLET[walletId];

  if (!source) {
    return null;
  }

  return {
    ...source,
    recentActivity: source.recentActivity.map((activity) => ({ ...activity })),
    streams: source.streams.map((stream) => ({ ...stream })),
  };
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
        detail: "All incoming and outgoing activity in the last 30 days",
        format: "currency",
        value: null,
        unavailableText: "No recent activity data",
      },
      {
        id: "net-flow-30d",
        label: "Net Flow (30D)",
        detail: "Incoming minus outgoing activity over the same period",
        format: "currency",
        value: null,
        unavailableText: "No recent activity data",
      },
      {
        id: "avg-value-per-stream",
        label: "Avg Locked Value / Active Stream",
        detail: "Current TVL divided by active stream count",
        format: "currency",
        value: null,
        unavailableText: "No active stream data",
      },
      {
        id: "stream-utilization",
        label: "Stream Utilization",
        detail: "Total withdrawn as a share of total deposited funds",
        format: "percent",
        value: null,
        unavailableText: "No stream funding data",
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

  const totalDeposited = snapshot.streams.reduce(
    (sum, stream) => sum + stream.deposited,
    0,
  );
  const totalWithdrawn = snapshot.streams.reduce(
    (sum, stream) => sum + stream.withdrawn,
    0,
  );
  const utilization = totalDeposited > 0 ? totalWithdrawn / totalDeposited : null;

  return [
    {
      id: "total-volume-30d",
      label: "Total Volume (30D)",
      detail: "All incoming and outgoing activity in the last 30 days",
      format: "currency",
      value: recentActivity.length > 0 ? totalVolume30d : null,
      unavailableText: "No activity in the last 30 days",
    },
    {
      id: "net-flow-30d",
      label: "Net Flow (30D)",
      detail: "Incoming minus outgoing activity over the same period",
      format: "currency",
      value: recentActivity.length > 0 ? netFlow30d : null,
      unavailableText: "No activity in the last 30 days",
    },
    {
      id: "avg-value-per-stream",
      label: "Avg Locked Value / Active Stream",
      detail: "Current TVL divided by active stream count",
      format: "currency",
      value: avgValuePerStream,
      unavailableText: "No active streams",
    },
    {
      id: "stream-utilization",
      label: "Stream Utilization",
      detail: "Total withdrawn as a share of total deposited funds",
      format: "percent",
      value: utilization,
      unavailableText: "No deposited funds yet",
    },
  ];
}
