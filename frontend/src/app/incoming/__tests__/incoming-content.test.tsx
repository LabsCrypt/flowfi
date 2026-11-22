import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The incoming page now derives its loading / error / empty / ready branches
// from `useAsyncPageData` (#1085). These tests pin the rendered result of each
// branch so the shared hook cannot silently change what the page shows.

const wallet = vi.hoisted(() => ({
  current: {
    session: { publicKey: "GAAAA", network: "testnet" } as Record<string, string> | null,
    status: "connected" as string,
    isHydrated: true,
  },
}));

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => wallet.current,
}));

vi.mock("@/components/TransactionTracker", () => ({
  default: () => null,
  useTransactionTracker: () => ({
    status: "idle",
    txHash: null,
    error: null,
    start: vi.fn(),
    submit: vi.fn(),
    confirm: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
  }),
}));

const query = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: null as unknown,
  },
}));

vi.mock("@/hooks/useIncomingStreams", () => ({
  useIncomingStreams: () => query.current,
  useWithdrawIncomingStream: () => ({
    isPending: false,
    variables: undefined,
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("@/components/streams/IncomingStreamCard", () => ({
  IncomingStreamCard: ({ stream }: { stream: { id: string } }) => (
    <div data-testid="stream-card">{stream.id}</div>
  ),
}));

import IncomingContent from "@/app/incoming/incoming-content";

function setWallet(overrides: Partial<typeof wallet.current> = {}) {
  wallet.current = { ...wallet.current, ...overrides };
}

beforeEach(() => {
  setWallet({
    session: { publicKey: "GAAAA", network: "testnet" },
    status: "connected",
    isHydrated: true,
  });
  query.current = { data: [], isLoading: false, isError: false, error: null };
});

describe("IncomingContent page states (#1085)", () => {
  it("shows skeletons before hydration has resolved the wallet", () => {
    setWallet({ isHydrated: false });
    render(<IncomingContent />);

    expect(screen.getByText(/Streams paying into your wallet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Connect a wallet to view incoming streams/i)).toBeNull();
    expect(screen.queryByTestId("stream-card")).toBeNull();
  });

  it("asks for a wallet once hydrated but still disconnected", () => {
    setWallet({ isHydrated: true, status: "disconnected", session: null });
    render(<IncomingContent />);

    expect(screen.getByText(/Connect a wallet to view incoming streams/i)).toBeInTheDocument();
  });

  it("renders the query error message when the fetch failed", () => {
    query.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("upstream exploded"),
    };
    render(<IncomingContent />);

    expect(screen.getByText(/We couldn.t load your incoming streams/i)).toBeInTheDocument();
    expect(screen.getByText("upstream exploded")).toBeInTheDocument();
  });

  it("prefers the error branch while a retry is already in flight", () => {
    query.current = {
      data: undefined,
      isLoading: true,
      isError: true,
      error: new Error("upstream exploded"),
    };
    render(<IncomingContent />);

    expect(screen.getByText(/We couldn.t load your incoming streams/i)).toBeInTheDocument();
  });

  it("falls back to a generic message when the error is not an Error", () => {
    query.current = { data: undefined, isLoading: false, isError: true, error: "nope" };
    render(<IncomingContent />);

    expect(screen.getByText("Please try again in a moment.")).toBeInTheDocument();
  });

  it("shows the empty state once loaded with no streams", () => {
    query.current = { data: [], isLoading: false, isError: false, error: null };
    render(<IncomingContent />);

    expect(screen.getByText(/No incoming streams yet/i)).toBeInTheDocument();
  });

  it("renders one card per stream when ready", () => {
    query.current = {
      data: [
        { id: "s1", streamId: 1, withdrawn: 0 },
        { id: "s2", streamId: 2, withdrawn: 0 },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<IncomingContent />);

    expect(screen.getAllByTestId("stream-card")).toHaveLength(2);
    expect(screen.queryByText(/No incoming streams yet/i)).toBeNull();
  });
});
