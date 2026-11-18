import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { ModeToggle } from "./ModeToggle";

function renderModeToggle() {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light" storageKey="theme">
      <ModeToggle />
    </ThemeProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
});

describe("ModeToggle", () => {
  it("toggles themes and persists the selected preference", async () => {
    const user = userEvent.setup();
    renderModeToggle();

    const toggle = await screen.findByRole("button", { name: "Switch to dark mode" });
    expect(toggle.querySelector("svg.text-yellow-500")).toBeInTheDocument();
    expect(toggle.querySelector("svg.text-blue-400")).toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
      expect(localStorage.getItem("theme")).toBe("dark");
      expect(document.documentElement).toHaveClass("dark");
    });

    await user.click(screen.getByRole("button", { name: "Switch to light mode" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
      expect(localStorage.getItem("theme")).toBe("light");
      expect(document.documentElement).not.toHaveClass("dark");
    });
  });

  it("can be focused and activated from the keyboard", async () => {
    const user = userEvent.setup();
    renderModeToggle();

    const toggle = await screen.findByRole("button", { name: "Switch to dark mode" });
    await user.tab();
    expect(toggle).toHaveFocus();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
      expect(localStorage.getItem("theme")).toBe("dark");
    });
  });
});
