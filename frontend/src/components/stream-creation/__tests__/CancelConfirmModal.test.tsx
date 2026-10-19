import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/lib/transaction-feedback", () => ({
  transactionSuccessToast: vi.fn(),
}));

import toast from "react-hot-toast";
import { transactionSuccessToast } from "@/lib/transaction-feedback";
import {
  CancelConfirmModal,
  calculateCancelSplitPercentages,
} from "../CancelConfirmModal";

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
    expect(transactionSuccessToast).toHaveBeenCalledWith("Stream stream-42 cancelled successfully");
  });

  it("shows toast.error and re-enables the confirm button when onConfirm rejects", async () => {
    baseProps.onConfirm.mockRejectedValueOnce(new Error("network error"));
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.click(getCancelButton());
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to cancel stream. Please try again.");
    });
    expect(getCancelButton()).toBeEnabled();
    expect(transactionSuccessToast).not.toHaveBeenCalled();
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

  describe("streamed vs refunded percentage bar", () => {
    it("renders dual-segment progress bar with 1-decimal formatted percentages", () => {
      render(
        <CancelConfirmModal
          {...baseProps}
          deposited={1000}
          withdrawn={645}
        />,
      );

      expect(screen.getByTestId("cancel-split-label")).toHaveTextContent(
        "64.5% Streamed / 35.5% Refunded",
      );
      const progressbar = screen.getByRole("progressbar", {
        name: /streamed vs refunded tokens/i,
      });
      expect(progressbar).toHaveAttribute("aria-valuenow", "64.5");
      expect(screen.getByTestId("cancel-streamed-segment")).toHaveStyle({
        width: "64.5%",
      });
      expect(screen.getByTestId("cancel-refunded-segment")).toHaveStyle({
        width: "35.5%",
      });
    });

    it("handles 0% streamed edge case without NaN", () => {
      render(
        <CancelConfirmModal
          {...baseProps}
          deposited={500}
          withdrawn={0}
        />,
      );

      expect(screen.getByTestId("cancel-split-label")).toHaveTextContent(
        "0.0% Streamed / 100.0% Refunded",
      );
      expect(screen.getByTestId("cancel-streamed-segment")).toHaveStyle({
        width: "0.0%",
      });
      expect(screen.getByTestId("cancel-refunded-segment")).toHaveStyle({
        width: "100.0%",
      });
    });

    it("handles 100% streamed and overflow edge cases without exceeding 100%", () => {
      const { rerender } = render(
        <CancelConfirmModal
          {...baseProps}
          deposited={500}
          withdrawn={500}
        />,
      );

      expect(screen.getByTestId("cancel-split-label")).toHaveTextContent(
        "100.0% Streamed / 0.0% Refunded",
      );
      expect(screen.getByTestId("cancel-streamed-segment")).toHaveStyle({
        width: "100.0%",
      });
      expect(screen.getByTestId("cancel-refunded-segment")).toHaveStyle({
        width: "0.0%",
      });

      // Withdrawn slightly exceeding deposited should clamp cleanly to 100.0% / 0.0%
      rerender(
        <CancelConfirmModal
          {...baseProps}
          deposited={500}
          withdrawn={600}
        />,
      );
      expect(screen.getByTestId("cancel-split-label")).toHaveTextContent(
        "100.0% Streamed / 0.0% Refunded",
      );

      // Zero or non-finite deposited should not produce NaN
      expect(calculateCancelSplitPercentages(0, 0).summaryLabel).toBe(
        "0.0% Streamed / 100.0% Refunded",
      );
      expect(calculateCancelSplitPercentages(Number.NaN, 50).summaryLabel).toBe(
        "0.0% Streamed / 100.0% Refunded",
      );
    });
  });
});