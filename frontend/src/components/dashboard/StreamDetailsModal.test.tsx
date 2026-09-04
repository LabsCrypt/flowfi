import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Stream } from "@/lib/dashboard";

const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("react-hot-toast", () => ({
  default: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { StreamDetailsModal } from "./StreamDetailsModal";

const STREAM: Stream = {
  id: "stream-1",
  recipient: "GRECIPIENT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
  amount: 100,
  token: "USDC",
  status: "Active",
  deposited: 100,
  withdrawn: 25,
  date: "2026-01-01",
  ratePerSecond: 0.001,
  lastUpdateTime: Date.now(),
  isActive: true,
};

describe("StreamDetailsModal clipboard copy", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it("shows an error toast instead of failing silently when the clipboard write is denied", async () => {
    // userEvent.setup() installs its own clipboard stub, so it must run
    // before we install ours or it will clobber this mock.
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(
      <StreamDetailsModal
        stream={STREAM}
        onClose={vi.fn()}
        onCancelClick={vi.fn()}
        onTopUpClick={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /copy recipient address/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(STREAM.recipient);
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard");
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows a success toast when the clipboard write succeeds", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(
      <StreamDetailsModal
        stream={STREAM}
        onClose={vi.fn()}
        onCancelClick={vi.fn()}
        onTopUpClick={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /copy recipient address/i }));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Recipient address copied");
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: /recipient address copied/i }),
    ).toBeInTheDocument();
  });
});
