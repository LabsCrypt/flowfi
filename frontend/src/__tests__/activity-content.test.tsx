import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────────
// ActivityContent fetches from /v1/events endpoint and handles various
// error states including unauthorized, timeout, and malformed responses.

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/context/wallet-context", () => {
  const session = {
    publicKey: "GABCDEFPUBLICKEY000000000000000000000000000000000000000",
  };
  return {
    useWallet: () => {
      const connected = localStorage.getItem("session") !== null;
      return {
        session: connected ? session : null,
        status: connected ? "connected" : "disconnected",
        disconnect: vi.fn(),
        isHydrated: true,
      };
    },
  };
});

vi.mock("@/lib/wallet", () => ({
  shortenPublicKey: (key: string) => `${key.slice(0, 4)}...${key.slice(-4)}`,
  formatNetwork: (n: string) => n,
  STELLAR_NETWORK: "TESTNET",
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Every icon used by the rendered tree (ActivityHistory, TransactionTracker and
// ActivityContent) must be stubbed: an undefined component type makes React
// unmount the tree, so the activity list would render as an empty container.
vi.mock("lucide-react", () => ({
  Loader2: () => null,
  Download: () => null,
  Clock: () => null,
  ExternalLink: () => null,
  CheckCircle: () => null,
  XCircle: () => null,
  RefreshCw: () => null,
  Ban: () => null,
  FileSearch: () => null,
}));

vi.mock("@/components/ui/Button", () => ({
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

// ─── Activity Content Component ────────────────────────────────────────────
import ActivityContent from "@/app/activity/activity-content";

describe("ActivityContent API failure states", () => {
  beforeEach(() => {
    // Clear any session to test unauthorized state
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });
  });

  it("shows access denied when wallet is not connected", () => {
    const { unmount } = render(<ActivityContent />);

    // Should show access denied state
    const accessDenied = screen.getByText(/Access Denied/);
    expect(accessDenied).toBeInTheDocument();

    const pleaseConnect = screen.getByText(/Please connect your wallet/);
    expect(pleaseConnect).toBeInTheDocument();

    unmount();
  });

  it("handles unauthorized API response (401)", async () => {
    // Mock connected session but unauthorized response
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to return 401
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: "Unauthorized" }),
      } as Response),
    ));

    const { unmount } = render(<ActivityContent />);

    // Should show error state after failed fetch
    await waitFor(() =>
      expect(screen.getByText(/failed to fetch activity/i)).toBeInTheDocument(),
    );

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeInTheDocument();

    unmount();
  });

  it("handles timeout API response", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to timeout
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Request timed out"))));

    const { unmount } = render(<ActivityContent />);

    // Should handle timeout gracefully
    await waitFor(() =>
      expect(screen.getByText(/failed to fetch activity/i)).toBeInTheDocument(),
    );

    unmount();
  });

  it("handles malformed API response (invalid JSON)", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to return non-ok response with malformed JSON
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        // Malformed JSON that can't be parsed
        json: async () => {
          throw new Error("Unexpected end of JSON input");
        },
      }),
    ));

    const { unmount } = render(<ActivityContent />);

    // Should handle malformed JSON gracefully
    await waitFor(() =>
      expect(screen.getByText(/failed to fetch activity/i)).toBeInTheDocument(),
    );

    unmount();
  });

  it("handles empty events response", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to return successful response with empty events
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          events: [],
          hasMore: false,
        }),
      } as Response),
    ));

    const { unmount } = render(<ActivityContent />);

    // Should show empty state when no events
    await waitFor(() =>
      expect(screen.getByText(/No activity found for this filter/i)).toBeInTheDocument(),
    );

    unmount();
  });

  it("handles partial events response", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to return successful response with partial events
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          events: [
            {
              id: "evt-1",
              streamId: 12345,
              eventType: "CREATED",
              amount: "10000000000",
              transactionHash: "",
              ledgerSequence: 1000,
              timestamp: 1700000000,
              metadata: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          hasMore: false,
        }),
      } as Response),
    ));

    const { unmount } = render(<ActivityContent />);

    // Should render activity with the events
    await waitFor(() =>
      expect(screen.getByText(/Stream Activity/i)).toBeInTheDocument(),
    );

    // Should show the event
    const createdText = await screen.findByText(
      (_, element) =>
        element?.tagName === "P" &&
        element.textContent?.startsWith("New stream created (") === true,
    );
    expect(createdText).toBeInTheDocument();

    unmount();
  });

  it("handles large page size response", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to return response with many events
    const manyEvents = Array.from({ length: 25 }, (_, i) => ({
      id: `evt-${i}`,
      streamId: 12345 + i,
      eventType: i % 2 === 0 ? "CREATED" : "TOPPED_UP",
      amount: "10000000000",
      transactionHash: i % 3 === 0 ? "" : "abc123",
      ledgerSequence: 1000 + i,
      timestamp: 1700000000 + i,
      metadata: i % 4 === 0 ? null : JSON.stringify({ key: "value" }),
      createdAt: "2026-01-01T00:00:00Z",
    }));

    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          events: manyEvents,
          hasMore: true,
        }),
      } as Response),
    ));

    const { unmount } = render(<ActivityContent />);

    // Should render activity with events
    await waitFor(() =>
      expect(screen.getByText(/Stream Activity/i)).toBeInTheDocument(),
    );

    // Should show load more button since hasMore is true
    const loadMoreButton = await screen.findByRole("button", {
      name: /Load More Activity/i,
    });
    expect(loadMoreButton).toBeInTheDocument();

    unmount();
  });

  it("handles network error during fetch", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "connected-token"),
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    // Mock fetch to throw network error
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.reject(new Error("Network error: fetch failed")),
    ));

    const { unmount } = render(<ActivityContent />);

    // Should handle network error gracefully
    await waitFor(() =>
      expect(screen.getByText(/failed to fetch activity/i)).toBeInTheDocument(),
    );

    unmount();
  });

  it("handles redirect after session expiry", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null), // No valid session
      setItem: vi.fn(),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });

    const { unmount } = render(<ActivityContent />);

    // Should show access denied when no session
    const accessDenied = screen.getByText(/Access Denied/);
    expect(accessDenied).toBeInTheDocument();

    const pleaseConnect = screen.getByText(/Please connect your wallet/);
    expect(pleaseConnect).toBeInTheDocument();

    unmount();
  });
});