import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("react-hot-toast", () => ({
  default: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it("writes text, shows a success toast, and resolves true on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const result = await copyToClipboard("GABC123");

    expect(writeText).toHaveBeenCalledWith("GABC123");
    expect(toastSuccess).toHaveBeenCalledWith("Copied to clipboard");
    expect(toastError).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("uses a custom success message when provided", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await copyToClipboard("GABC123", { successMessage: "Address copied to clipboard" });

    expect(toastSuccess).toHaveBeenCalledWith("Address copied to clipboard");
  });

  it("shows an error toast and resolves false when writeText rejects (e.g. permission denied)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const result = await copyToClipboard("GABC123");

    expect(result).toBe(false);
    expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("does not throw when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("nope"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await expect(copyToClipboard("text")).resolves.not.toThrow();
  });

  it("uses a custom error message when provided", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("nope"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await copyToClipboard("text", { errorMessage: "Could not copy address" });

    expect(toastError).toHaveBeenCalledWith("Could not copy address");
  });

  it("shows an error toast and resolves false when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const result = await copyToClipboard("GABC123");

    expect(result).toBe(false);
    expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard");
  });
});
