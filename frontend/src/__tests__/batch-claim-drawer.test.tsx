import { describe, expect, it, vi } from "vitest";

function claimable(deposited: number, withdrawn: number, ratePerSecond: number, elapsed: number, active = true) {
  return active ? Math.min(Math.max(0, deposited - withdrawn), elapsed * ratePerSecond) : 0;
}

describe("batch claim selection math", () => {
  it("caps accrued balance at the deposited remainder", () => { expect(claimable(10, 4, 1, 20)).toBe(6); });
  it("excludes inactive streams", () => { expect(claimable(10, 0, 1, 20, false)).toBe(0); });
});

describe("batch claim drawer dismissal", () => {
  it("closes the drawer on Escape key", () => {
    const onClose = vi.fn();
    const handleKeyDown = (e: { Key: string }) => {
      if (e.key === "Escape") onClose();
    };
    handleKeyDown({ key: "Tab" });
    expect(onClose).not.toHaveBeenCalled();
    handleKeyDown({ key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click without executing claims", () => {
    const onClose = vi.fn();
    const onClaim = vi.fn();
    const handleBackdropClick = (e: { target: unknown; currentTarget: unknown }) => {
      if (e.target === e.currentTarget) onClose();
    };
    const backdrop = { id: "backdrop" };
    const content = { id: "content" };
    handleBackdropClick({ target: content, currentTarget: backdrop });
    expect(onClose).not.toHaveBeenCalled();
    expect(onClaim).not.toHaveBeenCalled();
    handleBackdropClick({ target: backdrop, currentTarget: backdrop });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClaim).not.toHaveBeenCalled();
  });
});
