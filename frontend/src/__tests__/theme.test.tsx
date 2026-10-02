import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { applyTheme, isThemeChoice, THEME_CHOICES } from "@/lib/themes";

const setTheme = vi.fn();
let currentTheme = "dark";
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: currentTheme, setTheme }),
}));

import { ModeToggle } from "@/components/ModeToggle";

describe("ModeToggle", () => {
  beforeEach(() => {
    setTheme.mockClear();
    currentTheme = "dark";
  });

  it("offers System, Light, Dark and High contrast", async () => {
    await act(async () => {
      render(<ModeToggle />);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["System", "Light", "Dark", "High contrast"]);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });

  it("switches theme on click", async () => {
    await act(async () => {
      render(<ModeToggle />);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    fireEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    expect(setTheme).toHaveBeenCalledWith("high-contrast");
  });
});

describe("themes lib", () => {
  it("validates theme choices", () => {
    expect(THEME_CHOICES).toContain("high-contrast");
    expect(isThemeChoice("high-contrast")).toBe(true);
    expect(isThemeChoice("neon")).toBe(false);
  });

  it("applies class + data-theme to the root", () => {
    const root = document.createElement("html");
    applyTheme("high-contrast", root);
    expect(root.dataset.theme).toBe("high-contrast");
    expect(root.classList.contains("high-contrast")).toBe(true);
    applyTheme("light", root);
    expect(root.classList.contains("high-contrast")).toBe(false);
    expect(root.dataset.theme).toBe("light");
  });

  it("resolves system via matchMedia", () => {
    const root = document.createElement("html");
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    applyTheme("system", root);
    expect(root.dataset.theme).toBe("dark");
  });
});
