import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

import toast from "react-hot-toast";
import { TopUpModal } from "../TopUpModal";

describe("TopUpModal", () => {
  const baseProps = {
    streamId: "stream-42",
    token: "USDC",
    currentDeposited: 500,
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

  const getAmountInput = () => screen.getByLabelText(/amount to add/i) as HTMLInputElement;
  const getConfirmButton = () => screen.getByRole("button", { name: /confirm top up/i });

  it("renders stream info and current balance", () => {
    render(<TopUpModal {...baseProps} />);
    expect(screen.getByText("Top Up Stream")).toBeInTheDocument();
    expect(screen.getByText(/500 USDC/)).toBeInTheDocument();
  });

  describe("amount validation", () => {
    it("shows an error and does not submit when the amount is empty", () => {
      render(<TopUpModal {...baseProps} />);
      fireEvent.click(getConfirmButton());
      expect(screen.getByText("Amount is required")).toBeInTheDocument();
      expect(baseProps.onConfirm).not.toHaveBeenCalled();
    });

    it("shows an error and does not submit when the amount is zero", async () => {
      const user = userEvent.setup();
      render(<TopUpModal {...baseProps} />);
      await user.type(getAmountInput(), "0");
      fireEvent.click(getConfirmButton());
      expect(screen.getByText("Amount must be greater than 0")).toBeInTheDocument();
      expect(baseProps.onConfirm).not.toHaveBeenCalled();
    });

    it("rejects more than 7 decimal places while typing", async () => {
      const user = userEvent.setup();
      render(<TopUpModal {...baseProps} />);
      await user.type(getAmountInput(), "1.123456789");
      expect(getAmountInput().value).toBe("1.1234567");
    });

    it("does not submit when more than 7 decimal places are present", () => {
      render(<TopUpModal {...baseProps} />);
      fireEvent.change(getAmountInput(), { target: { value: "1.1234567" } });
      expect(getAmountInput().value).toBe("1.1234567");
      fireEvent.change(getAmountInput(), { target: { value: "1.12345678" } });
      expect(getAmountInput().value).toBe("1.1234567");
    });

    it("submits a valid amount and shows a success toast", async () => {
      const user = userEvent.setup();
      render(<TopUpModal {...baseProps} />);
      await user.type(getAmountInput(), "100.5");
      expect(screen.getByText(/600.50 USDC/)).toBeInTheDocument();
      fireEvent.click(getConfirmButton());
      await waitFor(() => {
        expect(baseProps.onConfirm).toHaveBeenCalledWith("stream-42", "100.5");
      });
      expect(toast.success).toHaveBeenCalledWith("Successfully added 100.5 USDC to stream");
    });
  });

  describe("submission error handling", () => {
    it("shows toast.error and re-enables the form when onConfirm rejects", async () => {
      const user = userEvent.setup();
      baseProps.onConfirm.mockRejectedValueOnce(new Error("tx failed"));
      render(<TopUpModal {...baseProps} />);
      await user.type(getAmountInput(), "10");
      fireEvent.click(getConfirmButton());
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Failed to top up stream. Please try again.");
      });
      expect(getConfirmButton()).toBeEnabled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe("close-while-submitting guard", () => {
    it("blocks close button, cancel, backdrop click, and Escape while submitting", async () => {
      let resolveConfirm!: (value: void) => void;
      const pendingConfirm = vi.fn(
        () => new Promise<void>((res) => {
          resolveConfirm = res;
        }),
      );
      const user = userEvent.setup();
      render(<TopUpModal {...baseProps} onConfirm={pendingConfirm} />);
      await user.type(getAmountInput(), "10");
      fireEvent.click(getConfirmButton());

      expect(screen.getByRole("button", { name: /topping up/i })).toBeDisabled();

      const closeButton = screen.getByRole("button", { name: /close/i });
      expect(closeButton).toBeDisabled();
      fireEvent.click(closeButton);
      expect(baseProps.onClose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
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
});
