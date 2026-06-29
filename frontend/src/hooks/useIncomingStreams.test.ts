import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  useIncomingStreams,
  useWithdrawIncomingStream,
  incomingStreamsQueryKey,
} from "./useIncomingStreams";
import { fetchIncomingStreams } from "@/lib/api/streams";
import { withdrawFromStream } from "@/lib/soroban";

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
  });

  describe("useWithdrawIncomingStream", () => {
    it("rejects when session is null", async () => {
      const { result } = renderHook(
        () => useWithdrawIncomingStream(null, "pubkey"),
        { wrapper }
      );

      await expect(
        result.current.mutateAsync({} as any)
      ).rejects.toThrow("Please connect your wallet first");
      expect(withdrawFromStream).not.toHaveBeenCalled();
    });

    it("invalidates incomingStreamsQueryKey(publicKey) on success", async () => {
      (withdrawFromStream as any).mockResolvedValue({ status: "success" });
      (fetchIncomingStreams as any).mockResolvedValue([]);
      
      const { result } = renderHook(
        () => useWithdrawIncomingStream({} as any, "pubkey"),
        { wrapper }
      );

      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      await act(async () => {
        await result.current.mutateAsync({
          id: 1,
          streamId: 1,
          withdrawn: 0,
          deposited: 100,
          ratePerSecond: 1,
          isPaused: false,
          lastUpdateTime: Date.now() / 1000,
        } as any);
      });

      // Wait for pollIndexerForWithdraw to complete and call invalidateQueries
      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: incomingStreamsQueryKey("pubkey"),
        });
      }, { timeout: 10000 });
    });
  });
});
