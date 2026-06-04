import { describe, it, expect } from "vitest";
import { mapBackendStreamToFrontend } from "../lib/dashboard";
import { TOKEN_ADDRESSES } from "../lib/soroban";
import type { BackendStream, BackendStreamEvent } from "../lib/api-types";

function makeStream(overrides: Partial<BackendStream> = {}): BackendStream {
  return {
    id: "db-1",
    streamId: 1,
    sender: "GSENDER000000000000000000000000000000000000000000000000",
    recipient: "GRECIPIENT0000000000000000000000000000000000000000000",
    tokenAddress: TOKEN_ADDRESSES.USDC,
    ratePerSecond: "1000000",
    depositedAmount: "100000000",
    withdrawnAmount: "20000000",
    startTime: 1_700_000_000,
    lastUpdateTime: 1_700_000_500,
    isActive: true,
    isPaused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const cancelledEvent: BackendStreamEvent = {
  id: "evt-1",
  streamId: 1,
  eventType: "CANCELLED",
  amount: null,
  transactionHash: "hash",
  ledgerSequence: 1,
  timestamp: 1_700_000_600,
  metadata: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("mapBackendStreamToFrontend", () => {
  describe("token label", () => {
    it("resolves known token addresses to their symbol", () => {
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: TOKEN_ADDRESSES.XLM }), "G").token).toBe("XLM");
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: TOKEN_ADDRESSES.USDC }), "G").token).toBe("USDC");
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: TOKEN_ADDRESSES.EURC }), "G").token).toBe("EURC");
    });

    it("falls back to a shortened address for unknown tokens", () => {
      const addr = "CUNKNOWNTOKENADDRESS000000000000000000000000000000000000";
      expect(mapBackendStreamToFrontend(makeStream({ tokenAddress: addr }), "G").token).toBe(
        `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      );
    });

    it("never returns the placeholder 'TOKEN'", () => {
      expect(mapBackendStreamToFrontend(makeStream(), "G").token).not.toBe("TOKEN");
    });
  });

  describe("status", () => {
    it("is Paused when the stream is paused", () => {
      expect(mapBackendStreamToFrontend(makeStream({ isPaused: true }), "G").status).toBe("Paused");
    });

    it("is Active when active and not paused", () => {
      expect(mapBackendStreamToFrontend(makeStream({ isActive: true, isPaused: false }), "G").status).toBe("Active");
    });

    it("is Cancelled when inactive with a CANCELLED event", () => {
      const s = makeStream({ isActive: false, isPaused: false, events: [cancelledEvent] });
      expect(mapBackendStreamToFrontend(s, "G").status).toBe("Cancelled");
    });

    it("is Completed when inactive without a CANCELLED event", () => {
      const s = makeStream({ isActive: false, isPaused: false, events: [] });
      expect(mapBackendStreamToFrontend(s, "G").status).toBe("Completed");
    });

    it("is Completed when inactive and events are absent", () => {
      const s = makeStream({ isActive: false, isPaused: false });
      expect(mapBackendStreamToFrontend(s, "G").status).toBe("Completed");
    });
  });
});
