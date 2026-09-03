import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { BackendStream } from "@/lib/api-types";

// Mock the toast singleton so we can assert on polling outcomes (success/timeout).
vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import toast from "react-hot-toast";
import TransactionTracker, { renderChanges, checkConfirmation } from "./TransactionTracker";

// Base stream builder so each test only overrides the fields it cares about.
const makeStream = (overrides: Partial<BackendStream> = {}): BackendStream => ({
  id: "1",
  streamId: 1,
  sender: "GBSENDER",
  recipient: "GBRECIPIENT",
  tokenAddress: "GBTOKEN",
  ratePerSecond: "1000",
  depositedAmount: "0",
  withdrawnAmount: "0",
  startTime: 0,
  lastUpdateTime: 0,
  isActive: false,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

describe("renderChanges", () => {
  it.each([
    {
      name: "deposit increase",
      prev: makeStream({ depositedAmount: "10000000" }),
      current: makeStream({ depositedAmount: "30000000" }),
      expected: ["Deposited: 2 tokens added"],
    },
    {
      name: "withdraw increase",
      prev: makeStream({ withdrawnAmount: "10000000" }),
      current: makeStream({ withdrawnAmount: "20000000" }),
      expected: ["Withdrawn: 1 tokens"],
    },
    {
      name: "status becomes active",
      prev: makeStream({ isActive: false }),
      current: makeStream({ isActive: true }),
      expected: ["Status: Active"],
    },
    {
      name: "status becomes inactive",
      prev: makeStream({ isActive: true }),
      current: makeStream({ isActive: false }),
      expected: ["Status: Inactive"],
    },
    {
      name: "deposit + withdraw + status change together",
      prev: makeStream({ depositedAmount: "10000000", withdrawnAmount: "0", isActive: true }),
      current: makeStream({ depositedAmount: "25000000", withdrawnAmount: "10000000", isActive: false }),
      expected: [
        "Deposited: 1.5 tokens added",
        "Withdrawn: 1 tokens",
        "Status: Inactive",
      ],
    },
    {
      name: "no changes",
      prev: makeStream({ depositedAmount: "10000000", withdrawnAmount: "10000000", isActive: true }),
      current: makeStream({ depositedAmount: "10000000", withdrawnAmount: "10000000", isActive: true }),
      expected: ["No significant changes detected"],
    },
  ])("handles: $name", ({ prev, current, expected }) => {
    const { container } = render(<>{renderChanges(prev, current)}</>);
    const text = container.textContent ?? "";
    for (const fragment of expected) {
      expect(text).toContain(fragment);
    }
  });
});

describe("checkConfirmation", () => {
  it("confirms immediately when there are no expected changes", () => {
    expect(checkConfirmation(makeStream(), undefined)).toBe(true);
  });

  it.each([
    {
      name: "matches only depositedAmount",
      stream: { depositedAmount: "100" },
      changes: { depositedAmount: "100" },
      expected: true,
    },
    {
      name: "depositedAmount not yet reflected",
      stream: { depositedAmount: "100" },
      changes: { depositedAmount: "200" },
      expected: false,
    },
    {
      name: "matches only withdrawnAmount",
      stream: { withdrawnAmount: "50" },
      changes: { withdrawnAmount: "50" },
      expected: true,
    },
    {
      name: "withdrawnAmount not yet reflected",
      stream: { withdrawnAmount: "50" },
      changes: { withdrawnAmount: "60" },
      expected: false,
    },
    {
      name: "matches isActive",
      stream: { isActive: true },
      changes: { isActive: true },
      expected: true,
    },
    {
      name: "isActive not yet reflected",
      stream: { isActive: true },
      changes: { isActive: false },
      expected: false,
    },
    {
      name: "one field matches but another does not",
      stream: { depositedAmount: "100", isActive: true },
      changes: { depositedAmount: "100", isActive: false },
      expected: false,
    },
    {
      name: "all specified fields match",
      stream: { depositedAmount: "100", withdrawnAmount: "50", isActive: true },
      changes: { depositedAmount: "100", withdrawnAmount: "50", isActive: true },
      expected: true,
    },
  ])("returns $expected when $name", ({ stream, changes, expected }) => {
    expect(checkConfirmation(makeStream(stream), changes)).toBe(expected);
  });
});

describe("TransactionTracker polling effect", () => {
  const POLL_INTERVAL = 3000;
  const MAX_POLL_ATTEMPTS = 20;

  const mockFetchReturning = (stream: BackendStream) =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => stream,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows success and stops polling once expected changes are confirmed", async () => {
    const fetchMock = mockFetchReturning(makeStream({ depositedAmount: "100" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TransactionTracker
        status="confirming"
        action="create"
        streamId="123"
        expectedChanges={{ depositedAmount: "100" }}
      />,
    );

    // Flush the initial poll + initial-state capture fetch.
    await act(async () => {
      await Promise.resolve();
    });

    expect(toast.success).toHaveBeenCalledWith("Stream created successfully!");
    // Capture fetch + first poll; any further polls would add more calls.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // More elapsed time must not schedule additional polls after confirmation.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces a timeout error after MAX_POLL_ATTEMPTS unsuccessful polls", async () => {
    // The indexer never reflects the expected deposit.
    const fetchMock = mockFetchReturning(makeStream({ depositedAmount: "0" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TransactionTracker
        status="confirming"
        action="withdraw"
        streamId="123"
        expectedChanges={{ depositedAmount: "999" }}
      />,
    );

    // Poll every POLL_INTERVAL for MAX_POLL_ATTEMPTS attempts, with slack for
    // the final scheduled run that reports the timeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL * (MAX_POLL_ATTEMPTS + 1) + 10);
    });

    expect(toast.error).toHaveBeenCalledWith(
      "Confirmation timeout - please check explorer for status",
    );
    expect(toast.success).not.toHaveBeenCalled();

    // MAX_POLL_ATTEMPTS data fetches + the single initial capture fetch. The
    // final run that hits the attempt cap returns before fetching.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_POLL_ATTEMPTS + 1);
  });
});