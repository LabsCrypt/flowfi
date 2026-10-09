import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WalletSession } from "@/lib/wallet";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  // Land on the Incoming tab so the incoming table (and its rows) renders.
  useSearchParams: vi.fn(() => new URLSearchParams("tab=incoming")),
}));

vi.mock("@/hooks/useStreamEvents", () => ({
  useStreamEvents: () => ({
    events: [],
    connected: true,
    reconnecting: false,
    error: null,
  }),
}));

const session: WalletSession = {
  walletId: "freighter",
  walletName: "Freighter",
  publicKey: "GABCDEFPUBLICKEY000000000000000000000000000000000000000",
  connectedAt: new Date().toISOString(),
  network: "TESTNET",
  mocked: false,
};

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({ session }),
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
  batchWithdrawFromStreams: vi.fn(),
  toBaseUnits: vi.fn((v: string) => BigInt(v)),
  toDurationSeconds: vi.fn(() => 0),
  getTokenAddress: vi.fn((symbol: string) => symbol),
  toSorobanErrorMessage: vi.fn((e) => String(e)),
  fetchTokenBalanceDisplay: vi.fn().mockResolvedValue("1000"),
  TOKEN_ADDRESSES: { XLM: "CXLM" },
}));

vi.mock("@/lib/stellar", () => ({
  isValidStellarPublicKey: vi.fn(() => true),
}));

vi.mock("@/components/dashboard/CashflowProjectionChart", () => ({
  CashflowProjectionChart: () => <div data-testid="cashflow-chart" />,
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

function backendStream(overrides: Record<string, unknown>) {
  return {
    id: "row",
    streamId: 1,
    sender: "GSENDER000000000000000000000000000000000000000000000000",
    recipient: "GRECIPIENT0000000000000000000000000000000000000000000000",
    tokenAddress: "CXLM",
    ratePerSecond: "100",
    depositedAmount: "100000000",
    withdrawnAmount: "0",
    startTime: 1_700_000_000,
    lastUpdateTime: 1_700_000_000,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    isActive: true,
    isPaused: false,
    events: [],
    ...overrides,
  };
}

const OUTGOING = [backendStream({ id: "out-1", streamId: 101 })];
const INCOMING = [
  backendStream({ id: "in-1", streamId: 1 }),
  backendStream({ id: "in-2", streamId: 2 }),
];

import { DashboardView } from "./dashboard-view";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardView session={session} onDisconnect={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function waitForRows() {
  await waitFor(() =>
    expect(document.querySelector('[data-stream-id="1"]')).not.toBeNull(),
  );
}

function press(key: string) {
  // Real key events target the focused element and bubble up to window; mirror
  // that so the "ignore while typing" behaviour is exercised faithfully.
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse(url.includes("sender=") ? OUTGOING : INCOMING);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DashboardView keyboard shortcuts", () => {
  it("moves the row selection with j / k", async () => {
    renderDashboard();
    await waitForRows();

    expect(
      document.querySelector('[data-stream-id="1"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      document.querySelector('[data-stream-id="2"]')?.getAttribute("aria-selected"),
    ).toBe("false");

    press("j");
    expect(
      document.querySelector('[data-stream-id="2"]')?.getAttribute("aria-selected"),
    ).toBe("true");

    press("k");
    expect(
      document.querySelector('[data-stream-id="1"]')?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("focuses the search field when / is pressed", async () => {
    renderDashboard();
    await waitForRows();

    press("/");
    expect(screen.getByLabelText("Search streams")).toHaveFocus();
  });

  it("opens the shortcuts cheatsheet with ? and closes it with Escape", async () => {
    renderDashboard();
    await waitForRows();

    expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).toBeNull();

    press("?");
    const dialog = screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/Focus the stream search/i);
    expect(dialog).toHaveTextContent(/Select the next stream/i);

    press("Escape");
    expect(screen.queryByRole("dialog", { name: /keyboard shortcuts/i })).toBeNull();
  });

  it("opens the batch claim drawer with c when funds are claimable", async () => {
    renderDashboard();
    await waitForRows();

    expect(screen.queryByLabelText(/batch claim drawer/i)).toBeNull();

    press("c");
    expect(screen.getByLabelText(/batch claim drawer/i)).toBeInTheDocument();
  });

  it("ignores shortcuts while typing in the search field", async () => {
    renderDashboard();
    await waitForRows();

    press("/");
    const input = screen.getByLabelText("Search streams");
    expect(input).toHaveFocus();

    // "j" is an editable character: it must be ignored by the global listener.
    press("j");
    expect(
      document.querySelector('[data-stream-id="1"]')?.getAttribute("aria-selected"),
    ).toBe("true");
  });
});
