import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// dashboard-view.tsx pulls in a lot of feature components (the stream
// creation wizard, modals, SSE status indicator, etc.) that aren't relevant
// to the "does switching tabs/routes re-trigger a network fetch within
// staleTime" question this file is about. They're stubbed out below so the
// test can focus on the useDashboard/query-cache wiring.

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
  toBaseUnits: vi.fn((v: string) => BigInt(v)),
  toDurationSeconds: vi.fn(() => 0),
  getTokenAddress: vi.fn((symbol: string) => symbol),
  toSorobanErrorMessage: vi.fn((e) => String(e)),
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
  TopUpModal: () => <div data-testid="topup-modal" />,
}));

vi.mock("../stream-creation/CancelConfirmModal", () => ({
  CancelConfirmModal: () => <div data-testid="cancel-modal" />,
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

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe("DashboardView + useDashboard cache integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not issue a duplicate network fetch when the dashboard is unmounted and remounted within staleTime (e.g. switching tabs away and back)", async () => {
    // Mirror the app's real QueryClient defaults (see
    // frontend/src/components/providers/query-provider.tsx) so this proves
    // the behavior users actually get: staleTime 10s means a remount within
    // that window should be served from cache, not refetched.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });

    const renderDashboard = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <DashboardView session={session} onDisconnect={vi.fn()} />
        </QueryClientProvider>,
      );

    const first = renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );
    // One request each for outgoing ("sender") and incoming ("recipient") streams.
    expect(fetch).toHaveBeenCalledTimes(2);

    // Simulate navigating/switching away from the dashboard and back within
    // the 10s staleTime window.
    first.unmount();

    render(
      <QueryClientProvider client={queryClient}>
        <DashboardView session={session} onDisconnect={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    // Still just the 2 calls from the first mount — the remounted dashboard
    // was served from the React Query cache instead of refetching.
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 20000);

  it("shows the loading skeleton, then renders content once useDashboard resolves", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DashboardView session={session} onDisconnect={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText(/loading dashboard/i)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );
  }, 20000);

  it("shows the error state with a retry button when the fetch fails, and retrying refetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DashboardView session={session} onDisconnect={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText(/failed to load streams/i)).toBeInTheDocument(),
    );

    const callsBeforeRetry = vi.mocked(fetch).mock.calls.length;

    vi.mocked(fetch).mockResolvedValue(jsonResponse([]));
    screen.getByRole("button", { name: /retry/i }).click();

    await waitFor(() =>
      expect(screen.getByText(/start your first stream/i)).toBeInTheDocument(),
    );

    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(
      callsBeforeRetry,
    );
  }, 20000);
});
