import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/lib/soroban", () => ({
  fetchTokenBalanceDisplay: vi.fn(),
}));

import { fetchTokenBalanceDisplay } from "@/lib/soroban";
import { useStreamForm } from "./useStreamForm";

const WALLET = "GABCDEFGHJKLMNPQRSTUVWXYZ234567ABCDEFGHJKLMNPQRSTUVWXYZ2";

describe("useStreamForm — setMaxAmount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchTokenBalanceDisplay).mockResolvedValue("100");
  });

  it("sets the XLM max to the balance minus the base reserve", async () => {
    const { result } = renderHook(() =>
      useStreamForm({ walletPublicKey: WALLET, initialData: { token: "XLM" } }),
    );

    await waitFor(() => expect(result.current.walletBalance).toBe("100"));

    act(() => result.current.setMaxAmount());

    expect(result.current.formData.amount).toBe("99");
  });

  it("sets the non-XLM max to the full balance", async () => {
    const { result } = renderHook(() =>
      useStreamForm({ walletPublicKey: WALLET, initialData: { token: "USDC" } }),
    );

    await waitFor(() => expect(result.current.walletBalance).toBe("100"));

    act(() => result.current.setMaxAmount());

    expect(result.current.formData.amount).toBe("100");
  });

  it("does nothing when no balance is available", async () => {
    vi.mocked(fetchTokenBalanceDisplay).mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() =>
      useStreamForm({ walletPublicKey: WALLET, initialData: { token: "XLM" } }),
    );

    await waitFor(() =>
      expect(result.current.walletBalanceError).not.toBeNull(),
    );

    act(() => result.current.setMaxAmount());

    expect(result.current.formData.amount).toBe("");
  });
});
