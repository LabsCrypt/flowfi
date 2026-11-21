import { describe, it, expect, vi, beforeEach } from "vitest";
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
    TOKEN_ADDRESSES: {
      USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN",
      EURC: "CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY",
    },
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


function streamFor(id: number) {
  return { ...createMockStream(), id: `stream-${id}`, streamId: id };
}

type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void };

// Routes fetches per stream id; stream detail requests are deferred so tests
// control the order in which responses arrive.
function installDeferredFetch() {
  const pending: Record<string, Deferred> = {};
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/events")) {
      return Promise.resolve({ ok: true, json: async () => ({ events: [], total: 0 }) } as Response);
    }
    const id = url.split("/streams/")[1] as string;
    return new Promise<Response>((resolve, reject) => {
      pending[id] = { resolve, reject };
    });
  }) as unknown as typeof fetch;
  return pending;
}

const okResponse = (id: number) => ({ ok: true, json: async () => streamFor(id) }) as Response;

describe("StreamDetailsContent stale stream responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    origUseWallet.mockReturnValue({ session: mockSession, isHydrated: true } as ReturnType<typeof origUseWallet>);
  });

  it("ignores a slow response for the previous stream id once the id changed", async () => {
    const pending = installDeferredFetch();
    const { rerender } = renderWithQueryClient(<StreamDetailsContent streamId="1" />);
    await waitFor(() => expect(pending["1"]).toBeDefined());

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StreamDetailsContent streamId="2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(pending["2"]).toBeDefined());

    await act(async () => pending["2"]!.resolve(okResponse(2)));
    await waitFor(() => expect(screen.getAllByText(/stream #2/i).length).toBeGreaterThan(0));

    await act(async () => pending["1"]!.resolve(okResponse(1)));
    expect(screen.queryByText(/stream #1\b/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/stream #2/i).length).toBeGreaterThan(0);
  });

  it("does not show an error from a failed request for the previous stream id", async () => {
    const pending = installDeferredFetch();
    const { rerender } = renderWithQueryClient(<StreamDetailsContent streamId="1" />);
    await waitFor(() => expect(pending["1"]).toBeDefined());

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StreamDetailsContent streamId="2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(pending["2"]).toBeDefined());
    await act(async () => pending["2"]!.resolve(okResponse(2)));
    await waitFor(() => expect(screen.getAllByText(/stream #2/i).length).toBeGreaterThan(0));

    await act(async () => pending["1"]!.reject(new Error("boom from stale request")));
    expect(screen.queryByText(/boom from stale request/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/stream #2/i).length).toBeGreaterThan(0);
  });

  it("shows the not-found error contract when the current stream request fails", async () => {
    const pending = installDeferredFetch();
    renderWithQueryClient(<StreamDetailsContent streamId="7" />);
    await waitFor(() => expect(pending["7"]).toBeDefined());

    await act(async () => pending["7"]!.resolve({ ok: false, status: 404, json: async () => ({}) } as Response));
    await waitFor(() => expect(screen.getByText(/stream not found/i)).toBeInTheDocument());
  });

  it("surfaces a network failure for the current stream id", async () => {
    const pending = installDeferredFetch();
    renderWithQueryClient(<StreamDetailsContent streamId="7" />);
    await waitFor(() => expect(pending["7"]).toBeDefined());

    await act(async () => pending["7"]!.reject(new Error("network down")));
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeInTheDocument());
  });
});
