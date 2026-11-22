import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as calc from "@/utils/cashflowCalculations";
import { CashflowProjectionChart } from "./CashflowProjectionChart";

const streams: calc.ProjectionStream[] = [
  { id: "s1", direction: "incoming", token: "USDC", deposited: 100, withdrawn: 0, ratePerSecond: 0.001, isActive: true },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CashflowProjectionChart render cost (#1888)", () => {
  it("does not recompute the projection when re-rendered with the same streams reference", () => {
    const spy = vi.spyOn(calc, "projectCashflow");
    const { rerender } = render(<CashflowProjectionChart streams={streams} />);
    const initial = spy.mock.calls.length;
    rerender(<CashflowProjectionChart streams={streams} />);
    rerender(<CashflowProjectionChart streams={streams} />);
    expect(spy.mock.calls.length).toBe(initial);
  });

  it("coalesces mouse-move hover updates into one animation frame", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => callbacks.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { callbacks[id - 1] = () => undefined; });
    const spy = vi.spyOn(calc, "projectCashflow");
    const { container } = render(<CashflowProjectionChart streams={streams} />);
    const svg = container.querySelector("svg")!;
    for (let i = 0; i < 50; i++) fireEvent.mouseMove(svg);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    act(() => callbacks.forEach((cb) => cb(0)));
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
