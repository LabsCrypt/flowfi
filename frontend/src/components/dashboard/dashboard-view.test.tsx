import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/hooks/useStreamEvents", () => ({
  useStreamEvents: () => ({
    events: [],
    connected: true,
    reconnecting: false,
    error: null,
  }),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => "toast-id"),
  },
}));

vi.mock("@/lib/soroban", () => ({
  createStream: vi.fn(),
  topUpStream: vi.fn(),
  cancelStream: vi.fn(),
  withdrawFromStream: vi.fn(),
  toBaseUnits: vi.fn((value: string) => BigInt(value)),
  toDurationSeconds: vi.fn(() => 0),
  getTokenAddress: vi.fn((symbol: string) => symbol),
  toSorobanErrorMessage: vi.fn((error: unknown) => String(error)),
  fetchTokenBalanceDisplay: vi.fn().mockResolvedValue("1000"),
}));

vi.mock("@/lib/stellar", () => ({
  isValidStellarPublicKey: vi.fn(() => true),
}));

vi.mock("../IncomingStreams", () => ({
  default: () => <div data-testid="incoming-streams" />,
}));

vi.mock("./SSEStatusIndicator", () => ({
  SSEStatusIndicator: () => <div data-testid="sse-status" />,
}));

vi.mock("../stream-creation/StreamCreationWizard", () => ({
  StreamCreationWizard: () => <div data-testid="stream-wizard" />,
}));

vi.mock("../stream-creation/TopUpModal", () => ({
  TopUpModal: ({
    streamId,
    onConfirm,
  }: {
    streamId: string;
    onConfirm: (streamId: string, amount: string) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() => {
        void onConfirm(streamId, "25").catch(() => undefined);
      }}
    >
      Confirm top-up
    </button>
  ),
}));

vi.mock("../stream-creation/CancelConfirmModal", () => ({
  CancelConfirmModal: ({
    streamId,
    onConfirm,
  }: {
    streamId: string;
    onConfirm: (streamId: string) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() => {
        void onConfirm(streamId).catch(() => undefined);
      }}
    >
      Confirm cancellation
    </button>
  ),
}));

vi.mock("./StreamDetailsModal", () => ({
  StreamDetailsModal: () => <div data-testid="details-modal" />,
}));

vi.mock("../ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    glow?: boolean;
    variant?: string;
    size?: string;
    children?: React.ReactNode;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

import { DashboardView } from "./dashboard-view";
import { cancelStream, topUpStream } from "@/lib/soroban";
import {
  dashboardQueryKey,
  type DashboardSnapshot,
  type Stream,
} from "@/lib/dashboard";
import type { WalletSession } from "@/lib/wallet";

const PUBLIC_KEY = "GABCDEFPUBLICKEY000000000000000000000000000000000000000";

const session: WalletSession = {
  walletId: "freighter",
  walletName: "Freighter",
  publicKey: PUBLIC_KEY,
  connectedAt: new Date().toISOString(),
  network: "TESTNET",
  mocked: false,
};

function makeStream(
  id: string,
  deposited: number,
  withdrawn: number,
): Stream {
  return {
    id,
    recipient: `GABCDEF12345678901234567890123456789012${id.slice(-1)}`,
    amount: deposited,
    token: "XLM",
    status: "Active",
    deposited,
    withdrawn,
    date: "2024-01-01",
    ratePerSecond: 10,
    lastUpdateTime: 1000,
    isActive: true,
  };
}

function renderDashboard(streams: Stream[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
  const snapshot: DashboardSnapshot = {
    totalSent: 0,
    totalReceived: 0,
    totalValueLocked: 1000,
    activeStreamsCount: streams.length,
    recentActivity: [],
    outgoingStreams: streams,
    incomingStreams: [],
  };
  queryClient.setQueryData(dashboardQueryKey(PUBLIC_KEY), snapshot);

  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardView session={session} onDisconnect={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("DashboardView failed actions", () => {
  beforeEach(() => {
    vi.mocked(topUpStream).mockReset();
    vi.mocked(cancelStream).mockReset();
  });

  it("preserves the deposited amount when a top-up fails", async () => {
    vi.mocked(topUpStream).mockRejectedValueOnce(new Error("top-up failed"));
    renderDashboard([makeStream("stream-1", 100, 0)]);

    expect(screen.getByText("100 XLM")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Funds" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm top-up" }));

    await waitFor(() => expect(topUpStream).toHaveBeenCalledTimes(1));
    expect(screen.getByText("100 XLM")).toBeInTheDocument();
  });

  it("keeps the stream active when cancellation fails", async () => {
    vi.mocked(cancelStream).mockRejectedValueOnce(new Error("cancel failed"));
    renderDashboard([makeStream("stream-1", 100, 50)]);

    expect(screen.getByText("50 XLM")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));

    await waitFor(() => expect(cancelStream).toHaveBeenCalledTimes(1));
    expect(screen.getByText("50 XLM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("does not change other streams when one top-up fails", async () => {
    vi.mocked(topUpStream).mockRejectedValueOnce(new Error("top-up failed"));
    renderDashboard([
      makeStream("stream-1", 100, 0),
      makeStream("stream-2", 200, 50),
    ]);

    fireEvent.click(screen.getAllByRole("button", { name: "Add Funds" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm top-up" }));

    await waitFor(() => expect(topUpStream).toHaveBeenCalledTimes(1));
    expect(screen.getByText("100 XLM")).toBeInTheDocument();
    expect(screen.getByText("200 XLM")).toBeInTheDocument();
    expect(screen.getByText("50 XLM")).toBeInTheDocument();
  });
});
