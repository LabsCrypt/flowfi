import { describe, it, expect } from "vitest";
import {
  mapBackendStreamToFrontend,
  getDashboardAnalytics,
  dashboardQueryKey,
  type DashboardSnapshot,
} from "./dashboard";
import type { BackendStream } from "./api-types";

// ── dashboardQueryKey ───────────────────────────────────────────────────────

describe("dashboardQueryKey", () => {
  it("returns tuple of 'dashboard' and publicKey", () => {
    expect(dashboardQueryKey("GCXYZ")).toEqual(["dashboard", "GCXYZ"]);
  });
});

// ── mapBackendStreamToFrontend ──────────────────────────────────────────────

function makeBackendStream(overrides: Partial<BackendStream> = {}): BackendStream {
  return {
    id: "1",
    streamId: 42,
    sender: "GAAAAAAA" + "A".repeat(50),
    recipient: "GBBBBBBB" + "B".repeat(50),
    tokenAddress: "CASCDUMMY" + "C".repeat(50),
    ratePerSecond: "10000000", // 1 XLM/s in stroops
    depositedAmount: "1000000000", // 100 XLM
    withdrawnAmount: "500000000", // 50 XLM
    startTime: 1700000000,
    lastUpdateTime: 1700001000,
    isActive: true,
    isPaused: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

describe("mapBackendStreamToFrontend", () => {
  it("converts a basic active stream", () => {
    const bs = makeBackendStream();
    const result = mapBackendStreamToFrontend(bs, "GCOUNTERPARTY");

    expect(result.id).toBe("42");
    expect(result.recipient).toContain("...");
    expect(result.deposited).toBeCloseTo(100);
    expect(result.withdrawn).toBeCloseTo(50);
    expect(result.ratePerSecond).toBeCloseTo(1);
    expect(result.status).toBe("Active");
    expect(result.isActive).toBe(true);
  });

  it("marks paused stream as Paused", () => {
    const bs = makeBackendStream({ isPaused: true, isActive: false });
    const result = mapBackendStreamToFrontend(bs, "GCOUNTERPARTY");
    expect(result.status).toBe("Paused");
  });

  it("marks completed stream (inactive, no CANCELLED event)", () => {
    const bs = makeBackendStream({ isActive: false, events: [] });
    const result = mapBackendStreamToFrontend(bs, "GCOUNTERPARTY");
    expect(result.status).toBe("Completed");
  });

  it("marks cancelled stream when CANCELLED event present", () => {
    const bs = makeBackendStream({
      isActive: false,
      events: [{ id: "1", streamId: 42, eventType: "CANCELLED", amount: null, transactionHash: "tx1", ledgerSequence: 1, timestamp: 1, metadata: null, createdAt: "" }],
    });
    const result = mapBackendStreamToFrontend(bs, "GCOUNTERPARTY");
    expect(result.status).toBe("Cancelled");
  });

  it("formats date as YYYY-MM-DD", () => {
    const bs = makeBackendStream({ startTime: 1700000000 });
    const result = mapBackendStreamToFrontend(bs, "GCOUNTERPARTY");
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── getDashboardAnalytics ──────────────────────────────────────────────────

describe("getDashboardAnalytics", () => {
  it("returns unavailable text when snapshot is null", () => {
    const metrics = getDashboardAnalytics(null);
    expect(metrics).toHaveLength(4);
    metrics.forEach((m) => {
      expect(m.value).toBeNull();
      expect(m.unavailableText).toBeTruthy();
    });
  });

  it("computes metrics from a snapshot", () => {
    const now = Date.now();
    const snapshot: DashboardSnapshot = {
      totalSent: 100,
      totalReceived: 200,
      totalValueLocked: 500,
      activeStreamsCount: 2,
      recentActivity: [
        { id: "1", title: "Out", description: "", amount: 10, direction: "sent", timestamp: new Date(now).toISOString() },
        { id: "2", title: "In", description: "", amount: 30, direction: "received", timestamp: new Date(now).toISOString() },
      ],
      outgoingStreams: [
        { id: "1", recipient: "", amount: 100, token: "XLM", status: "Active", deposited: 100, withdrawn: 20, date: "", ratePerSecond: 1, lastUpdateTime: now / 1000, isActive: true },
      ],
      incomingStreams: [
        { id: "2", recipient: "", amount: 50, token: "XLM", status: "Active", deposited: 50, withdrawn: 30, date: "", ratePerSecond: 1, lastUpdateTime: now / 1000, isActive: true },
      ],
    };

    const metrics = getDashboardAnalytics(snapshot);
    expect(metrics).toHaveLength(4);

    const volume30d = metrics.find((m) => m.id === "total-volume-30d")!;
    expect(volume30d.value).toBe(40); // 10 + 30

    const netFlow = metrics.find((m) => m.id === "net-flow-30d")!;
    expect(netFlow.value).toBe(20); // 30 - 10

    const avgValue = metrics.find((m) => m.id === "avg-value-per-stream")!;
    expect(avgValue.value).toBe(250); // 500 / 2

    const utilization = metrics.find((m) => m.id === "stream-utilization")!;
    // totalWithdrawn = 20 + 30 = 50, totalDeposited = 100 + 50 = 150
    expect(utilization.value).toBeCloseTo(50 / 150, 4);
  });

  it("returns null avg when no active streams", () => {
    const snapshot: DashboardSnapshot = {
      totalSent: 0,
      totalReceived: 0,
      totalValueLocked: 0,
      activeStreamsCount: 0,
      recentActivity: [],
      outgoingStreams: [],
      incomingStreams: [],
    };

    const metrics = getDashboardAnalytics(snapshot);
    const avgValue = metrics.find((m) => m.id === "avg-value-per-stream")!;
    expect(avgValue.value).toBeNull();
  });

  it("returns null utilization when nothing deposited", () => {
    const snapshot: DashboardSnapshot = {
      totalSent: 0,
      totalReceived: 0,
      totalValueLocked: 0,
      activeStreamsCount: 0,
      recentActivity: [],
      outgoingStreams: [],
      incomingStreams: [],
    };

    const metrics = getDashboardAnalytics(snapshot);
    const util = metrics.find((m) => m.id === "stream-utilization")!;
    expect(util.value).toBeNull();
  });

  it("filters out activity older than 30 days", () => {
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const snapshot: DashboardSnapshot = {
      totalSent: 0,
      totalReceived: 0,
      totalValueLocked: 0,
      activeStreamsCount: 0,
      recentActivity: [
        { id: "old", title: "", description: "", amount: 100, direction: "sent", timestamp: oldTime },
        { id: "new", title: "", description: "", amount: 50, direction: "received", timestamp: recentTime },
      ],
      outgoingStreams: [],
      incomingStreams: [],
    };

    const metrics = getDashboardAnalytics(snapshot);
    const volume30d = metrics.find((m) => m.id === "total-volume-30d")!;
    expect(volume30d.value).toBe(50); // only the recent activity
  });
});
