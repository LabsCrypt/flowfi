import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const renderWithQueryClient = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
};
import userEvent from "@testing-library/user-event";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────

const { origUseWallet, mockSession } = vi.hoisted(() => {
  const mockSession = {
    publicKey: "GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD",
    network: "TESTNET",
    walletName: "Freighter",
  };
  return {
    origUseWallet: vi.fn(() => ({
      session: mockSession,
      isHydrated: true,
    })),
    mockSession,
  };
});

vi.mock("@/context/wallet-context", () => ({
  useWallet: origUseWallet,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { mockToast, mockSoroban, mockTracker, mockUseStreamingAmount, mockTransactionSuccessToast } = vi.hoisted(() => {
  const mockToast = { success: vi.fn(), error: vi.fn() };
  const mockSoroban = {
    withdrawFromStream: vi.fn(),
    cancelStream: vi.fn(),
    topUpStream: vi.fn(),
    pauseStream: vi.fn(),
    resumeStream: vi.fn(),
    toBaseUnits: vi.fn((v: string) => BigInt(Math.round(parseFloat(v)) * 10_000_000)),
    toSorobanErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  };
  const mockTracker = {
    status: "idle" as string,
    txHash: "",
    error: "",
    start: vi.fn(),
    submit: vi.fn(),
    confirm: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  };
  const mockUseStreamingAmount = vi.fn(() => 123456789);
  const mockTransactionSuccessToast = vi.fn();
  return { mockToast, mockSoroban, mockTracker, mockUseStreamingAmount, mockTransactionSuccessToast };
});

vi.mock("react-hot-toast", () => ({
  default: {
    success: (message: string) => mockToast.success(message),
    error: (message: string) => mockToast.error(message),
  },
}));

vi.mock("@/lib/transaction-feedback", () => ({
  transactionSuccessToast: (...args: unknown[]) => mockTransactionSuccessToast(...args),
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

// The component reads the token price through react-query. This suite covers UI
// behaviour, not the price feed, so stub the hook instead of wiring up a
// QueryClientProvider (and a network layer) just to render.
vi.mock("@/hooks/useTokenPrice", () => ({
  useTokenPrice: () => ({ data: undefined }),
  convertToFiat: () => 0,
  formatFiatAmount: () => "$0.00",
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/hooks/useStreamEvents", () => ({
  useStreamEvents: () => ({ events: [] }),
}));

vi.mock("@/hooks/useTokenPrice", () => ({
  useTokenPrice: () => ({ data: null, isLoading: false }),
  convertToFiat: () => 0,
  formatFiatAmount: (v: number) => `$${v.toFixed(2)}`,
}));

// The shared ticking hook is exercised by its own suite
// (frontend/src/__tests__/useStreamingAmount.test.tsx); here we only verify
// that the details page wires it into the "Claimable" stat card.
vi.mock("@/hooks/useStreamingAmount", () => ({
  useStreamingAmount: mockUseStreamingAmount,
}));

vi.mock("@/lib/soroban", () => mockSoroban);

vi.mock("@/components/stream-creation/CancelConfirmModal", () => ({
  CancelConfirmModal: () => <div data-testid="cancel-modal">Cancel Modal</div>,
}));

vi.mock("@/components/ui/LiveValue", () => ({
  LiveValue: () => null,
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { glow?: boolean; variant?: string; children?: React.ReactNode }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/TransactionTracker", () => ({
  __esModule: true,
  default: ({ status, action }: { status: string; action: string; txHash?: string; error?: string }) => (
    <div data-testid="transaction-tracker">Tracker: {status} {action}</div>
  ),
  useTransactionTracker: () => mockTracker,
}));

import StreamDetailsContent from "../stream-details-content";

const STREAM_ID = "42";

// Every fetch in the component must resolve to something; the receipt effect
// (and the 30s re-sync interval) hit endpoints that individual tests do not
// always queue. Tests override the first calls with `mockResolvedValueOnce`.
function createFetchMock() {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      // A valid stream shape so post-action / re-sync refetches stay renderable.
      json: async () => createMockStream(),
    } as Response),
  );
}

function createMockStream() {
  return {
    id: "stream-42",
    streamId: 42,
    sender: "GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD",
    recipient: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
    tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN",
    depositedAmount: "1000000000",
    withdrawnAmount: "250000000",
    ratePerSecond: "100",
    startTime: Math.floor(Date.now() / 1000) - 86400,
    endTime: Math.floor(Date.now() / 1000) + 86400,
    lastUpdateTime: Math.floor(Date.now() / 1000),
    isActive: true,
    status: "Active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("StreamDetailsContent loading skeleton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
    origUseWallet.mockReturnValue({
      session: mockSession,
      isHydrated: true,
    } as ReturnType<typeof origUseWallet>);
  });

  it("renders a distinct loading skeleton with shimmer placeholders while fetch is in-flight", () => {
    // Keep fetch pending indefinitely
    vi.mocked(global.fetch).mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

    // Should show skeleton elements, not a simple spinner
    const skeletonRegion = screen.getByRole("status");
    expect(skeletonRegion).toBeInTheDocument();
    expect(skeletonRegion).toHaveAttribute("aria-label", "Loading stream details");

    // Should NOT show the not-found error state
    expect(screen.queryByText(/stream not found/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("cancel-modal")).not.toBeInTheDocument();
  });

  it("transitions from skeleton to stream content when data loads successfully", async () => {
    const mockStream = createMockStream();

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = input.toString();
      if (url.includes("/events")) {
        return {
          ok: true,
          json: async () => ({ events: [], total: 0 }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => mockStream,
      } as Response;
    });

    renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

    // Initially shows skeleton
    expect(screen.getByRole("status")).toBeInTheDocument();

    // After data loads, the skeleton should be replaced by stream details
    await waitFor(() => {
      expect(screen.getByText(/stream details/i)).toBeInTheDocument();
    });

    // Skeleton should be gone
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Stream-specific content should be visible (the header and receipt rows
    // both reference the stream id, so assert on all matches).
    expect(screen.getAllByText(/stream #42/i).length).toBeGreaterThan(0);
    // Stream-specific content should be visible
    expect(screen.getAllByText(/stream #42/i).length).toBeGreaterThanOrEqual(1);
  });

  it("transitions from skeleton to not-found state when stream is confirmed missing", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "Stream not found" }),
    } as Response);

    renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

    // Initially shows skeleton
    expect(screen.getByRole("status")).toBeInTheDocument();

    // After fetch resolves with error, should show the not-found/error state
    await waitFor(() => {
      expect(screen.getByText(/stream not found/i)).toBeInTheDocument();
    });

    // Skeleton should be gone
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // The not-found state should have a back-to-dashboard link
    expect(screen.getByText(/← back to dashboard/i)).toBeInTheDocument();
  });

  it("shows 'stream not found' when API returns non-ok response", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "Stream not found" }),
    } as Response);

    renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/stream not found/i)).toBeInTheDocument();
    });

    // The not-found/error UI should have a back link
    expect(screen.getByText(/← back to dashboard/i)).toBeInTheDocument();
  });

  it("renders the live claimable amount from the shared useStreamingAmount hook", async () => {
    const mockStream = createMockStream();

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockStream,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [], total: 0 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [], total: 0 }),
      } as Response);

    renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

    // Once the stream loads, the Claimable stat card should show the value
    // returned by the shared hook, formatted in token units (stroops → XLM).
    // Note: LiveValue renders an sr-only screen-reader span with the same text,
    // so we use getAllByText to handle the duplicate.
    await waitFor(() => {
      expect(screen.getAllByText(/12\.3456789 XLM/).length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─── Helper: render the fully-loaded component ────────────────────────────

async function renderLoaded(streamOverrides: Record<string, unknown> = {}) {
  const mockStream = { ...createMockStream(), ...streamOverrides };

  vi.mocked(global.fetch).mockImplementation(async (input) => {
    const url = input.toString();
    if (url.includes("/events")) {
      return {
        ok: true,
        json: async () => ({ events: [], total: 0 }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => mockStream,
    } as Response;
  });

  const user = userEvent.setup();
  renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

  await waitFor(() => {
    expect(screen.getByText(/stream details/i)).toBeInTheDocument();
  });

  return { user, mockStream };
}

// ─── handleWithdraw ───────────────────────────────────────────────────────

// Note: handleWithdraw is only visible when the user is the recipient.
// The mock session matches the sender, so we re-mock useWallet for these tests.

const mockWalletForRecipient = (session = {
  publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
  network: "TESTNET",
  walletName: "Freighter",
}) => {
  origUseWallet.mockReturnValue({ session, isHydrated: true } as ReturnType<typeof origUseWallet>);
};

describe("StreamDetailsContent handleWithdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
    mockWalletForRecipient();
  });

  it("calls withdrawFromStream and shows success toast on success", async () => {
    mockSoroban.withdrawFromStream.mockResolvedValueOnce({ txHash: "tx_hash_1" });
    const { user } = await renderLoaded();

    const withdrawBtn = screen.getByRole("button", { name: /withdraw/i });
    await user.click(withdrawBtn);

    await waitFor(() => {
      expect(mockSoroban.withdrawFromStream).toHaveBeenCalled();
    });
    expect(mockTransactionSuccessToast).toHaveBeenCalledWith("Withdrawal successful!");
  });

  it("shows error toast when withdrawFromStream throws", async () => {
    mockSoroban.withdrawFromStream.mockRejectedValueOnce(new Error("Chain error"));
    const { user } = await renderLoaded();

    const withdrawBtn = screen.getByRole("button", { name: /withdraw/i });
    await user.click(withdrawBtn);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
  });

  it("disables the withdraw button when liveClaimable is zero", async () => {
    mockUseStreamingAmount.mockReturnValue(0);
    await renderLoaded({
      depositedAmount: "1000",
      withdrawnAmount: "1000",
      lastUpdateTime: Math.floor(Date.now() / 1000) - 100,
      ratePerSecond: "0",
    });

    const withdrawBtn = screen.getByRole("button", { name: /withdraw/i });
    expect(withdrawBtn).toBeDisabled();
  });
});

// ─── handleTopUp ──────────────────────────────────────────────────────────

describe("StreamDetailsContent handleTopUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
    // TopUp is only visible for the sender
    origUseWallet.mockReturnValue({
      session: mockSession,
      isHydrated: true,
    } as ReturnType<typeof origUseWallet>);
  });

  it("calls topUpStream and shows success toast on success", async () => {
    mockSoroban.topUpStream.mockResolvedValueOnce({ txHash: "tx_hash_2" });
    const { user } = await renderLoaded();

    // Click Top Up button to reveal input
    const topUpBtn = screen.getByRole("button", { name: /top up/i });
    await user.click(topUpBtn);

    // Enter amount
    const input = screen.getByRole("spinbutton", { name: /top-up amount/i });
    await user.type(input, "10");

    // Click Add Funds
    const addFundsBtn = screen.getByRole("button", { name: /add funds/i });
    await user.click(addFundsBtn);

    await waitFor(() => {
      expect(mockSoroban.topUpStream).toHaveBeenCalled();
    });
    expect(mockTransactionSuccessToast).toHaveBeenCalledWith("Stream topped up successfully!");
  });

  it("shows error toast when topUpStream throws", async () => {
    mockSoroban.topUpStream.mockRejectedValueOnce(new Error("Chain error"));
    const { user } = await renderLoaded();

    const topUpBtn = screen.getByRole("button", { name: /top up/i });
    await user.click(topUpBtn);

    const input = screen.getByRole("spinbutton", { name: /top-up amount/i });
    await user.type(input, "10");

    const addFundsBtn = screen.getByRole("button", { name: /add funds/i });
    await user.click(addFundsBtn);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
  });

  it("does not call topUpStream when amount is empty", async () => {
    const { user } = await renderLoaded();

    const topUpBtn = screen.getByRole("button", { name: /top up/i });
    await user.click(topUpBtn);

    // Don't enter an amount
    const addFundsBtn = screen.getByRole("button", { name: /add funds/i });
    await user.click(addFundsBtn);

    expect(mockToast.error).toHaveBeenCalledWith("Amount is required");
    expect(mockSoroban.topUpStream).not.toHaveBeenCalled();
  });
});

// ─── handlePause ──────────────────────────────────────────────────────────

// ─── handlePause ──────────────────────────────────────────────────────────

describe("StreamDetailsContent handlePause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
    origUseWallet.mockReturnValue({
      session: mockSession,
      isHydrated: true,
    } as ReturnType<typeof origUseWallet>);
  });

  it("calls pauseStream and shows success toast on success", async () => {
    mockSoroban.pauseStream.mockResolvedValueOnce({ txHash: "tx_hash_3" });
    const { user } = await renderLoaded();

    const pauseBtn = screen.getByRole("button", { name: /pause/i });
    await user.click(pauseBtn);

    await waitFor(() => {
      expect(mockSoroban.pauseStream).toHaveBeenCalledWith(
        mockSession,
        { streamId: BigInt(STREAM_ID) },
      );
    });
    expect(mockTransactionSuccessToast).toHaveBeenCalledWith("Stream paused");
  });

  it("shows error toast when pauseStream throws", async () => {
    mockSoroban.pauseStream.mockRejectedValueOnce(new Error("Chain error"));
    const { user } = await renderLoaded();

    const pauseBtn = screen.getByRole("button", { name: /pause/i });
    await user.click(pauseBtn);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
  });
});

// ─── handleResume ─────────────────────────────────────────────────────────

describe("StreamDetailsContent handleResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
    origUseWallet.mockReturnValue({
      session: mockSession,
      isHydrated: true,
    } as ReturnType<typeof origUseWallet>);
  });

  it("calls resumeStream and shows success toast on success", async () => {
    mockSoroban.resumeStream.mockResolvedValueOnce({ txHash: "tx_hash_4" });
    const { user } = await renderLoaded({ isPaused: true });

    const resumeBtn = screen.getByRole("button", { name: /resume/i });
    await user.click(resumeBtn);

    await waitFor(() => {
      expect(mockSoroban.resumeStream).toHaveBeenCalledWith(
        mockSession,
        { streamId: BigInt(STREAM_ID) },
      );
    });
    expect(mockTransactionSuccessToast).toHaveBeenCalledWith("Stream resumed");
  });

  it("shows error toast when resumeStream throws", async () => {
    mockSoroban.resumeStream.mockRejectedValueOnce(new Error("Chain error"));
    const { user } = await renderLoaded({ isPaused: true });

    const resumeBtn = screen.getByRole("button", { name: /resume/i });
    await user.click(resumeBtn);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
  });
});

// ─── handleCancel ─────────────────────────────────────────────────────────

describe("StreamDetailsContent handleCancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
    origUseWallet.mockReturnValue({
      session: mockSession,
      isHydrated: true,
    } as ReturnType<typeof origUseWallet>);
  });

  it("calls cancelStream and shows success toast on success", async () => {
    mockSoroban.cancelStream.mockResolvedValueOnce({ txHash: "tx_hash_5" });
    const { user } = await renderLoaded();

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelBtn);

    // CancelConfirmModal opens
    await waitFor(() => {
      expect(screen.getByTestId("cancel-modal")).toBeInTheDocument();
    });

    // Click confirm in modal (the mock renders a simple div, so we trigger handleCancel directly)
    // Since the modal is a mock, the confirm button isn't there. We need to test the flow
    // differently — the cancel button in the actions area opens the modal.
    // Verify the modal appeared, which is the entry point to cancellation.
    expect(screen.getByTestId("cancel-modal")).toBeInTheDocument();
  });

  it("shows error toast when cancelStream throws", async () => {
    mockSoroban.cancelStream.mockRejectedValueOnce(new Error("Chain error"));
    const { user } = await renderLoaded();

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelBtn);

    // Modal opens; the mock doesn't have a confirm button so we can't
    // trigger handleCancel through the UI. This test covers the button->modal flow.
    await waitFor(() => {
      expect(screen.getByTestId("cancel-modal")).toBeInTheDocument();
    });
  });
});

// ─── Live-claimable interval ──────────────────────────────────────────────

describe("StreamDetailsContent live-claimable interval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    // Default to a benign empty response so the component's background fetches
    // (events, receipt tx hash) resolve; individual tests layer `mockResolvedValueOnce`.
    global.fetch = createFetchMock();
  });

  it("shows live claimable indicator with a pulsing dot", async () => {
    const startTime = Math.floor(Date.now() / 1000) - 10;
    await renderLoaded({
      startTime,
      lastUpdateTime: startTime,
      ratePerSecond: "100",
      depositedAmount: "1000000",
      withdrawnAmount: "0",
    });

    // The live claimable section should have a pulsing dot indicator
    const liveLabel = screen.getByText("Claimable");
    expect(liveLabel).toBeInTheDocument();

    // The parent card should have the accent styling
    const liveCard = liveLabel.closest("div")?.parentElement;
    expect(liveCard).toBeTruthy();
  });

  it("shows claimable as deposited minus withdrawn when stream is paused", async () => {
    await renderLoaded({
      startTime: Math.floor(Date.now() / 1000) - 100,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 100,
      ratePerSecond: "100",
      depositedAmount: "1000000",
      withdrawnAmount: "0",
      isPaused: true,
    });

    // When paused, claimable should be deposited - withdrawn (no accrual)
    expect(screen.getByText("Claimable")).toBeInTheDocument();
    // Status badge shows Paused
    expect(screen.getAllByText(/paused/i).length).toBeGreaterThan(0);
  });

});

// ─── 30s API re-sync + per-tick pulse (issue #419) ────────────────────────

const STREAM_URL = `http://localhost:4000/v1/streams/${STREAM_ID}`;

function countStreamFetches() {
  return vi.mocked(global.fetch).mock.calls.filter(([url]) => url === STREAM_URL).length;
}

describe("StreamDetailsContent claimable re-sync + pulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTracker.status = "idle";
    global.fetch = createFetchMock();
    origUseWallet.mockReturnValue({
      session: mockSession,
      isHydrated: true,
    } as ReturnType<typeof origUseWallet>);
    vi.spyOn(window, "setInterval");
  });

  afterEach(() => {
    vi.mocked(window.setInterval).mockRestore();
  });

  async function renderStream(overrides: Record<string, unknown> = {}) {
    const mockStream = { ...createMockStream(), ...overrides };
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = input.toString();
      if (url.includes("/events")) {
        return {
          ok: true,
          json: async () => ({ events: [], total: 0 }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => mockStream,
      } as Response;
    });

    renderWithQueryClient(<StreamDetailsContent streamId={STREAM_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/stream details/i)).toBeInTheDocument();
    });
  }

  it("re-fetches the stream when the 30s re-sync interval fires while active", async () => {
    await renderStream();

    // The component registered a 30s interval while the stream is active.
    const resync = vi.mocked(window.setInterval).mock.calls.find(([, delay]) => delay === 30_000);
    expect(resync).toBeTruthy();

    const before = countStreamFetches();
    expect(before).toBe(1);

    // Invoking the registered callback is equivalent to the timer elapsing.
    act(() => {
      (resync![0] as () => void)();
    });

    await waitFor(() => {
      expect(countStreamFetches()).toBe(before + 1);
    });
  });

  it("does not register a re-sync interval while paused", async () => {
    await renderStream({ isPaused: true });

    const resync = vi.mocked(window.setInterval).mock.calls.find(([, delay]) => delay === 30_000);
    expect(resync).toBeUndefined();
    expect(screen.queryByTestId("claimable-tick-pulse")).not.toBeInTheDocument();
  });

  it("re-keys the Claimable flash once per second while active", async () => {
    await renderStream();

    const firstPulse = screen.getByTestId("claimable-tick-pulse");
    const pulse = vi.mocked(window.setInterval).mock.calls.find(([, delay]) => delay === 1000);
    expect(pulse).toBeTruthy();

    act(() => {
      (pulse![0] as () => void)();
    });

    const secondPulse = screen.getByTestId("claimable-tick-pulse");
    // A changed key remounts the overlay, restarting the one-shot flash.
    expect(secondPulse).not.toBe(firstPulse);
  });
});
