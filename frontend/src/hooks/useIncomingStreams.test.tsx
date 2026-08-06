import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  useIncomingStreams,
  useWithdrawIncomingStream,
  incomingStreamsQueryKey,
} from "./useIncomingStreams";
import { fetchIncomingStreams, type IncomingStreamRecord } from "@/lib/api/streams";
import { withdrawFromStream } from "@/lib/soroban";
import type { WalletSession } from "@/lib/wallet";

vi.mock("@/lib/api/streams", () => ({
  fetchIncomingStreams: vi.fn(),
}));

vi.mock("@/lib/soroban", () => ({
  withdrawFromStream: vi.fn(),
}));

describe("useIncomingStreams hooks", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  describe("incomingStreamsQueryKey", () => {
    it("returns correct shape", () => {
      expect(incomingStreamsQueryKey("pubkey")).toEqual([
        "incoming-streams",
        "pubkey",
      ]);
      expect(incomingStreamsQueryKey(null)).toEqual(["incoming-streams", null]);
    });
  });

  describe("useIncomingStreams", () => {
    it("stays disabled when publicKey is null/undefined", () => {
      const { result, rerender } = renderHook(
        (props: { publicKey: string | null | undefined }) =>
          useIncomingStreams(props.publicKey),
        { wrapper, initialProps: { publicKey: null } }
      );

      expect(result.current.isPending).toBe(true);
      expect(result.current.fetchStatus).toBe("idle");
      expect(fetchIncomingStreams).not.toHaveBeenCalled();

      rerender({ publicKey: undefined });
      expect(result.current.fetchStatus).toBe("idle");
      expect(fetchIncomingStreams).not.toHaveBeenCalled();
    });

    it("does not poll by default", async () => {
      vi.useFakeTimers();
      vi.mocked(fetchIncomingStreams).mockResolvedValue([]);

      renderHook(() => useIncomingStreams("pubkey"), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(fetchIncomingStreams).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("polls at the provided refetchInterval when overridden", async () => {
      vi.useFakeTimers();
      vi.mocked(fetchIncomingStreams).mockResolvedValue([]);

      renderHook(
        () => useIncomingStreams("pubkey", { refetchInterval: 5000 }),
        { wrapper },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(vi.mocked(fetchIncomingStreams).mock.calls.length).toBeGreaterThan(1);
      vi.useRealTimers();
    });
  });

  describe("useWithdrawIncomingStream", () => {
    it("rejects when session is null", async () => {
      const { result } = renderHook(
        () => useWithdrawIncomingStream(null, "pubkey"),
        { wrapper }
      );

      await expect(
        result.current.mutateAsync({} as unknown as IncomingStreamRecord)
      ).rejects.toThrow("Please connect your wallet first");
      expect(withdrawFromStream).not.toHaveBeenCalled();
    });

    it("invalidates incomingStreamsQueryKey(publicKey) on success", async () => {
      vi.useFakeTimers();
      vi.mocked(withdrawFromStream).mockResolvedValue({ success: true, txHash: "tx-hash" });
      vi.mocked(fetchIncomingStreams).mockResolvedValue([]);
      const { result } = renderHook(
        () => useWithdrawIncomingStream({} as unknown as WalletSession, "pubkey"),
        { wrapper }
      );

      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      await act(async () => {
        await result.current.mutateAsync({
          id: "1",
          streamId: 1,
          withdrawn: 0,
          deposited: 100,
          ratePerSecond: 1,
          isPaused: false,
          lastUpdateTime: Date.now() / 1000,
        } as unknown as IncomingStreamRecord);
      });

      // pollIndexerForWithdraw retries with exponential backoff
      // (1+2+4+8+16+32s) before falling back to invalidateQueries, so
      // fast-forward the fake clock past all retries.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(63_000);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: incomingStreamsQueryKey("pubkey"),
      });
    });
  });
});
