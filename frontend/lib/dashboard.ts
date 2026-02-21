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
