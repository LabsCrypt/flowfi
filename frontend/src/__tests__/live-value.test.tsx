import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { LiveValue } from "@/components/ui/LiveValue";

afterEach(() => cleanup());

describe("LiveValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a polite atomic live region with the current value", () => {
    const { container } = render(<LiveValue value="12.5 USDC" prefix="Claimable amount" />);
    const region = container.querySelector('span[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-atomic")).toBe("true");
    expect(region?.textContent).toBe("Claimable amount 12.5 USDC");
  });

  it("throttles announcements (at most one per cadence, not one per frame)", () => {
    const { container, rerender } = render(<LiveValue value="1" />);
    expect(container.querySelector('span[aria-live="polite"]')?.textContent).toBe("1");

    // Rapid value updates before the cadence elapses are not announced.
    rerender(<LiveValue value="2" />);
    rerender(<LiveValue value="2.0001" />);
    expect(container.querySelector('span[aria-live="polite"]')?.textContent).toBe("1");

    // After the cadence, the latest value is announced.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('span[aria-live="polite"]')?.textContent).toBe("2.0001");

    // An unchanged value does not re-announce.
    rerender(<LiveValue value="2.0001" />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('span[aria-live="polite"]')?.textContent).toBe("2.0001");
  });

  it("announces the settled value within one cadence after streaming stops", () => {
    const { container, rerender } = render(<LiveValue value="1" />);

    rerender(<LiveValue value="1.0005" />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('span[aria-live="polite"]')?.textContent).toBe("1.0005");
  });

  it("provides no live region until a value is announced", () => {
    const { container } = render(<LiveValue value="" />);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});