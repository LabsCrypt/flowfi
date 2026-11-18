import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";

describe("Card", () => {
  it("renders its children", () => {
    render(
      <Card>
        <span>Inner content</span>
      </Card>
    );
    expect(screen.getByText("Inner content")).toBeInTheDocument();
  });

  it("applies the base card styling", () => {
    const { container } = render(<Card>Base</Card>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("glass-card");
    expect(el.className).toContain("rounded-2xl");
    expect(el.className).toContain("p-6");
  });

  it("adds the glow class when glow is set", () => {
    const { container } = render(<Card glow>Glowing</Card>);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "glow-card"
    );
  });

  it("omits the glow class by default", () => {
    const { container } = render(<Card>Plain</Card>);
    expect((container.firstElementChild as HTMLElement).className).not.toContain(
      "glow-card"
    );
  });

  it("applies hover styling by default", () => {
    const { container } = render(<Card>Hover</Card>);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "hover:-translate-y-1"
    );
  });

  it("omits hover styling when hover is false", () => {
    const { container } = render(<Card hover={false}>Static</Card>);
    expect((container.firstElementChild as HTMLElement).className).not.toContain(
      "hover:-translate-y-1"
    );
  });

  it("merges a custom className", () => {
    const { container } = render(<Card className="custom-class">Custom</Card>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("glass-card");
    expect(el.className).toContain("custom-class");
  });
});
