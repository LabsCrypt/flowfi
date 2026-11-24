import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Click me</Button>);
    expect(
      screen.getByRole("button", { name: "Click me" })
    ).toBeInTheDocument();
  });

  it("applies the primary/md styling by default", () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-accent");
    expect(button.className).toContain("px-6");
    expect(button.className).toContain("text-sm");
  });

  it.each([
    ["secondary", "bg-accent-secondary"],
    ["outline", "bg-glass"],
    ["ghost", "text-slate-400"],
  ] as const)("applies the %s variant classes", (variant, expectedClass) => {
    render(<Button variant={variant}>Variant</Button>);
    expect(screen.getByRole("button").className).toContain(expectedClass);
  });

  it.each([
    ["sm", "px-4"],
    ["md", "px-6"],
    ["lg", "px-8"],
  ] as const)("applies the %s size classes", (size, expectedClass) => {
    render(<Button size={size}>Size</Button>);
    expect(screen.getByRole("button").className).toContain(expectedClass);
  });

  it("applies the glow shadow classes when glow is set", () => {
    render(<Button glow>Glow</Button>);
    expect(screen.getByRole("button").className).toContain(
      "shadow-[0_0_20px_rgba(16,185,129,0.3)]"
    );
  });

  it("is disabled when disabled is true", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("is disabled, aria-busy, and announces Loading while loading", () => {
    render(<Button loading>Loading...</Button>);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("is idle and not busy when not loading", () => {
    render(<Button>Idle</Button>);
    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
  });
});
