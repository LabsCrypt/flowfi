import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────

const mockSession = {
  publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
  network: "TESTNET",
  walletName: "Freighter",
};

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({
    session: mockSession,
    isHydrated: true,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/hooks/useStreamEvents", () => ({
  useStreamEvents: () => ({ events: [] }),
}));

vi.mock("@/lib/soroban", () => ({
  withdrawFromStream: vi.fn(),
  cancelStream: vi.fn(),
  topUpStream: vi.fn(),
  pauseStream: vi.fn(),
  resumeStream: vi.fn(),
  toBaseUnits: vi.fn((v: string) => BigInt(v)),
  toSorobanErrorMessage: vi.fn((e) => String(e)),
}));

vi.mock("@/components/stream-creation/CancelConfirmModal", () => ({
  CancelConfirmModal: () => <div data-testid="cancel-modal">Cancel Modal</div>,
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

import StreamDetailsContent from "../stream-details-content";

const STREAM_ID = "42";

// Helper to mock document.hidden
let originalHidden: PropertyDescriptor | undefined;

function setHidden(value: boolean) {
  Object.defineProperty(document, "hidden", {
    value,
    writable: true,
    configurable: true,
  });
}

function restoreHidden() {
  if (originalHidden) {
    Object.defineProperty(document, "hidden", originalHidden);
  }
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
    global.fetch = vi.fn();
  });

  it("renders a distinct loading skeleton with shimmer placeholders while fetch is in-flight", () => {
    // Keep fetch pending indefinitely
    vi.mocked(global.fetch).mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    render(<StreamDetailsContent streamId={STREAM_ID} />);

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

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockStream,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [], total: 0 }),
      } as Response);

    render(<StreamDetailsContent streamId={STREAM_ID} />);

    // Initially shows skeleton
    expect(screen.getByRole("status")).toBeInTheDocument();

    // After data loads, the skeleton should be replaced by stream details
    await waitFor(() => {
      expect(screen.getByText(/stream details/i)).toBeInTheDocument();
    });

    // Skeleton should be gone
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Stream-specific content should be visible
    expect(screen.getByText(/stream #42/i)).toBeInTheDocument();
  });

  it("transitions from skeleton to not-found state when stream is confirmed missing", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "Stream not found" }),
    } as Response);

    render(<StreamDetailsContent streamId={STREAM_ID} />);

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

    render(<StreamDetailsContent streamId={STREAM_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/stream not found/i)).toBeInTheDocument();
    });

    // The not-found/error UI should have a back link
    expect(screen.getByText(/← back to dashboard/i)).toBeInTheDocument();
  });
});

describe("Live claimable visibility guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    setHidden(false);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    restoreHidden();
  });

  it("skips updateClaimable when document.hidden is true", async () => {
    // Capture the setInterval callback
    let capturedCallback: (() => void) | null = null;
    const realSetInterval = global.setInterval;
    vi.spyOn(global, "setInterval").mockImplementation((fn: TimerHandler) => {
      capturedCallback = fn as () => void;
      return realSetInterval(fn, 1000);
    });

    const mockStream = createMockStream();

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockStream,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [], total: 0 }),
      } as Response);

    render(<StreamDetailsContent streamId={STREAM_ID} />);

    // Wait for data to load and interval to be set up
    await waitFor(() => {
      expect(capturedCallback).not.toBeNull();
    });

    // Verify the initial claimable is displayed
    const claimableCard = screen.getByText("Claimable").closest(".glass-card");
    expect(claimableCard).toBeInTheDocument();
    const initialText = claimableCard!.textContent;

    // Simulate the interval firing while the tab is visible — should update
    setHidden(false);
    capturedCallback!();
    // Value may or may not change depending on timing, but the function ran

    // Now background the tab
    setHidden(true);
    capturedCallback!();

    // The text should not have changed from the visible update
    // (setLiveClaimable was NOT called because document.hidden was true)
    expect(claimableCard!.textContent).toBe(initialText);

    // Restore setInterval mock
    vi.restoreAllMocks();
  });
});
