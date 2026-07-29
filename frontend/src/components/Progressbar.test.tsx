import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ProgressBar from "./Progressbar";

describe("ProgressBar", () => {
  it("renders the ARIA progressbar attributes reflecting the current value", () => {
    render(<ProgressBar percentage={42} label="Vested" />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "42%");
    expect(bar).toHaveAttribute("aria-label", "Vested");
  });

  it("clamps the value and updates the ARIA attributes when props change", () => {
    const { rerender } = render(<ProgressBar percentage={150} />);

    let bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-label", "Progress");

    rerender(<ProgressBar percentage={-10} />);
    bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
  });
});
