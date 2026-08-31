import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

import toast from "react-hot-toast";
import { CancelConfirmModal } from "../CancelConfirmModal";

describe("CancelConfirmModal submission and validation", () => {
  const baseProps = {
    streamId: "stream-42",
    recipient: "GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD",
    token: "USDC",
    deposited: 1000,
    withdrawn: 200,
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.style.overflow = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  const getCancelButton = () => screen.getByRole("button", { name: /yes, cancel stream/i });

  it("shows a success toast when cancellation succeeds", async () => {
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.click(getCancelButton());
    await waitFor(() => {
      expect(baseProps.onConfirm).toHaveBeenCalledWith("stream-42");
    });
    expect(toast.success).toHaveBeenCalledWith("Stream stream-42 cancelled successfully");
  });

  it("shows toast.error and re-enables the confirm button when onConfirm rejects", async () => {
    baseProps.onConfirm.mockRejectedValueOnce(new Error("network error"));
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.click(getCancelButton());
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to cancel stream. Please try again.");
    });
    expect(getCancelButton()).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("blocks close button, keep stream, backdrop click, and Escape while submitting", async () => {
    let resolveConfirm!: (value: void) => void;
    const pendingConfirm = vi.fn(
      () => new Promise<void>((res) => {
        resolveConfirm = res;
      }),
    );
    render(<CancelConfirmModal {...baseProps} onConfirm={pendingConfirm} />);
    fireEvent.click(getCancelButton());

    expect(screen.getByRole("button", { name: /cancelling/i })).toBeDisabled();

    const closeButton = screen.getByRole("button", { name: /close/i });
    expect(closeButton).toBeDisabled();
    fireEvent.click(closeButton);
    expect(baseProps.onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /keep stream/i }));
    expect(baseProps.onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog"));
    expect(baseProps.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(baseProps.onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm();
    });
  });
});
