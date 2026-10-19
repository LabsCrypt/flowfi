import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Stepper } from "./Stepper";

const steps = ["Connect", "Configure", "Confirm"];

/** Class names of every element matching `selector`, in document order. */
function allClasses(container: HTMLElement, selector: string): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).map(
    (el) => el.className
  );
}

/** The `index`-th match for `selector`, failing loudly if it is missing. */
function nth(container: HTMLElement, selector: string, index: number): HTMLElement {
  const el = container.querySelectorAll<HTMLElement>(selector)[index];
  if (!el) {
    throw new Error(`expected at least ${index + 1} match(es) for "${selector}"`);
  }
  return el;
}

describe("Stepper", () => {
  it("renders every step inside an accessible Progress landmark", () => {
    render(<Stepper steps={steps} currentStep={1} />);
    expect(
      screen.getByRole("navigation", { name: "Progress" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Connect")).toBeInTheDocument();
    expect(screen.getByText("Configure")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
  });

  it("marks only the active step with aria-current=step", () => {
    render(<Stepper steps={steps} currentStep={2} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[2]).not.toHaveAttribute("aria-current");
  });

  it("applies completed/active/upcoming classes per step index", () => {
    const { container } = render(<Stepper steps={steps} currentStep={2} />);

    expect(allClasses(container, ".stepper__circle")).toEqual([
      expect.stringContaining("stepper__circle--completed"),
      expect.stringContaining("stepper__circle--active"),
      expect.stringContaining("stepper__circle--upcoming"),
    ]);
    expect(allClasses(container, ".stepper__label")).toEqual([
      expect.stringContaining("stepper__label--completed"),
      expect.stringContaining("stepper__label--active"),
      expect.stringContaining("stepper__label--upcoming"),
    ]);
  });

  it("adds the matching screen-reader suffix to each step", () => {
    render(<Stepper steps={steps} currentStep={2} />);
    expect(screen.getByText("(completed)")).toBeInTheDocument();
    expect(screen.getByText("(current step)")).toBeInTheDocument();
    expect(screen.getByText("(upcoming)")).toBeInTheDocument();
  });

  it("shows a check icon for completed steps and a number otherwise", () => {
    const { container } = render(<Stepper steps={steps} currentStep={2} />);

    expect(nth(container, ".stepper__circle", 0).querySelector("svg")).not.toBeNull();
    expect(nth(container, ".stepper__circle", 1).querySelector("svg")).toBeNull();
    expect(nth(container, ".stepper__circle", 2).querySelector("svg")).toBeNull();
    expect(
      nth(container, ".stepper__circle", 1).querySelector(".stepper__number")
        ?.textContent
    ).toBe("2");
    expect(
      nth(container, ".stepper__circle", 2).querySelector(".stepper__number")
        ?.textContent
    ).toBe("3");
  });
});
