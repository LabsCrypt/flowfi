import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchClaimDrawer } from "@/components/dashboard/BatchClaimDrawer";

vi.mock("@/context/wallet-context", () => ({ useWallet: () => ({ session: null }) }));
vi.mock("@/lib/soroban", () => ({ batchWithdrawFromStreams: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("lucide-react", () => ({ X: () => null }));

function claimable(deposited: number, withdrawn: number, ratePerSecond: number, elapsed: number, active = true) {
  return active ? Math.min(Math.max(0, deposited - withdrawn), elapsed * ratePerSecond) : 0;
}

const streams = [{ id: "1", isActive: true, status: "Active", lastUpdateTime: Date.now() / 1000 - 10, deposited: 10, withdrawn: 0, ratePerSecond: 1, token: "USDC", recipient: "GTEST" }] as any;

describe("batch claim drawer", () => {
  it("caps accrued balance at the deposited remainder", () => { expect(claimable(10, 4, 1, 20)).toBe(6); });
  it("excludes inactive streams", () => { expect(claimable(10, 0, 1, 20, false)).toBe(0); });
  it("closes when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<BatchClaimDrawer streams={streams} onClose={onClose} onSuccess={vi.fn()} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("closes when the backdrop is clicked without submitting claims", () => {
    const onClose = vi.fn();
    render(<BatchClaimDrawer streams={streams} onClose={onClose} onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
