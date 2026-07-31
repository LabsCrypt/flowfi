import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Features } from "./Features";

describe("Features", () => {
  it("renders all expected feature titles", () => {
    render(<Features />);

    expect(screen.getByText("Per-Second Streaming")).toBeInTheDocument();
    expect(screen.getByText("Zero Overhead")).toBeInTheDocument();
    expect(screen.getByText("Institutional Grade")).toBeInTheDocument();
  });

  it("renders exactly three feature cards", () => {
    render(<Features />);

    const heading = screen.getByRole("heading", { level: 3, name: "Per-Second Streaming" });
    const cardGrid = heading.closest("div.grid");
    expect(cardGrid).not.toBeNull();

    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings).toHaveLength(3);
  });
});
