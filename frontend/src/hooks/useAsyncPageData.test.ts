import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAsyncPageData } from "./useAsyncPageData";
import { useWallet } from "@/context/wallet-context";

vi.mock("@/context/wallet-context", () => ({
  useWallet: vi.fn(),
}));

describe("useAsyncPageData", () => {
  const mockUseWallet = vi.mocked(useWallet);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns isLoading true when not hydrated", () => {
    mockUseWallet.mockReturnValue({
      session: null,
      status: "disconnected",
      isHydrated: false,
    } as any);

    const { result } = renderHook(() => useAsyncPageData({ data: [] }));

    expect(result.current.isHydrated).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isEmpty).toBe(false);
  });

  it("returns isConnected false when status is disconnected", () => {
    mockUseWallet.mockReturnValue({
      session: null,
      status: "disconnected",
      isHydrated: true,
    } as any);

    const { result } = renderHook(() => useAsyncPageData({ data: [] }));

    expect(result.current.isConnected).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isEmpty).toBe(false);
  });

  it("handles loading state when wallet is connected", () => {
    mockUseWallet.mockReturnValue({
      session: { publicKey: "G123" },
      status: "connected",
      isHydrated: true,
    } as any);

    const { result } = renderHook(() =>
      useAsyncPageData({ isLoading: true, data: undefined })
    );

    expect(result.current.isConnected).toBe(true);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isEmpty).toBe(false);
  });

  it("evaluates empty state when data is empty array", () => {
    mockUseWallet.mockReturnValue({
      session: { publicKey: "G123" },
      status: "connected",
      isHydrated: true,
    } as any);

    const { result } = renderHook(() =>
      useAsyncPageData({ isLoading: false, data: [] })
    );

    expect(result.current.isConnected).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isEmpty).toBe(true);
  });

  it("parses Error message on error state", () => {
    mockUseWallet.mockReturnValue({
      session: { publicKey: "G123" },
      status: "connected",
      isHydrated: true,
    } as any);

    const { result } = renderHook(() =>
      useAsyncPageData({
        isLoading: false,
        isError: true,
        error: new Error("Network failure"),
      })
    );

    expect(result.current.isError).toBe(true);
    expect(result.current.errorMessage).toBe("Network failure");
    expect(result.current.isEmpty).toBe(false);
  });
});
