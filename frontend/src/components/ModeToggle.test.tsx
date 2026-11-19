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

    const darkRadio = await screen.findByRole("radio", { name: "Dark" });
    const lightRadio = screen.getByRole("radio", { name: "Light" });

    expect(lightRadio).toHaveAttribute("aria-checked", "true");

    await user.click(darkRadio);

    await waitFor(() => {
      expect(darkRadio).toHaveAttribute("aria-checked", "true");
      expect(localStorage.getItem("theme")).toBe("dark");
      expect(document.documentElement).toHaveClass("dark");
    });

    await user.click(lightRadio);
    await waitFor(() => {
      expect(lightRadio).toHaveAttribute("aria-checked", "true");
      expect(localStorage.getItem("theme")).toBe("light");
      expect(document.documentElement).not.toHaveClass("dark");
    });
  });

  it("can be focused and activated from the keyboard", async () => {
    const user = userEvent.setup();
    renderModeToggle();

    const darkRadio = await screen.findByRole("radio", { name: "Dark" });
    darkRadio.focus();
    expect(darkRadio).toHaveFocus();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(darkRadio).toHaveAttribute("aria-checked", "true");
      expect(localStorage.getItem("theme")).toBe("dark");
    });
  });
});
