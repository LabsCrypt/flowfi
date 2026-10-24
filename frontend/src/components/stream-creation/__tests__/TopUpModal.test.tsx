import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/lib/transaction-feedback", () => ({
  transactionSuccessToast: vi.fn(),
}));

import toast from "react-hot-toast";
import { transactionSuccessToast } from "@/lib/transaction-feedback";
import {
  TopUpModal,
  calculateRunwayPresetAmount,
  calculateProjectedEndDate,
} from "../TopUpModal";

describe("TopUpModal", () => {
  const baseProps = {
    streamId: "stream-42",
    token: "USDC",
    currentDeposited: 500,
    ratePerSecond: 0.01,
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

    it("accepts the maximum supported precision at the amount boundary", async () => {
      const user = userEvent.setup();
      render(<TopUpModal {...baseProps} />);
      await user.type(getAmountInput(), "1.1234567");

      fireEvent.click(getConfirmButton());

      await waitFor(() => {
        expect(baseProps.onConfirm).toHaveBeenCalledWith("stream-42", "1.1234567");
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
      expect(transactionSuccessToast).toHaveBeenCalledWith("Successfully added 100.5 USDC to stream");
    });
  });

  describe("quick runway presets and projected end date", () => {
    it("populates exact deposit amounts when clicking +7 Days, +30 Days, or +90 Days", () => {
      // ratePerSecond = 0.01 => 864 tokens/day
      render(<TopUpModal {...baseProps} ratePerSecond={0.01} />);

      fireEvent.click(screen.getByRole("button", { name: /\+7 Days/i }));
      expect(getAmountInput().value).toBe("6048");
      expect(screen.getByText(/6548\.00 USDC/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /\+30 Days/i }));
      expect(getAmountInput().value).toBe("25920");
      expect(screen.getByText(/26420\.00 USDC/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /\+90 Days/i }));
      expect(getAmountInput().value).toBe("77760");
      expect(screen.getByText(/78260\.00 USDC/)).toBeInTheDocument();
    });

    it("displays the new projected end date below the input when an amount is entered", () => {
      const fixedStart = new Date("2026-05-01T00:00:00.000Z");
      render(
        <TopUpModal
          {...baseProps}
          ratePerSecond={0.01}
          currentEndTime={fixedStart}
        />,
      );

      expect(screen.queryByTestId("projected-end-date")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /\+30 Days/i }));

      const projected = screen.getByTestId("projected-end-date");
      expect(projected).toBeInTheDocument();
      expect(projected).toHaveTextContent("2026-05-31");
      expect(projected).toHaveTextContent("May 31, 2026");
    });

    it("handles non-positive or invalid ratePerSecond and days safely in helpers", () => {
      expect(calculateRunwayPresetAmount(0, 7)).toBe("0");
      expect(calculateRunwayPresetAmount(-1, 7)).toBe("0");
      expect(calculateRunwayPresetAmount(0.01, 0)).toBe("0");
      expect(calculateProjectedEndDate(0, 0.01)).toBeNull();
      expect(calculateProjectedEndDate(100, 0)).toBeNull();
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
      expect(transactionSuccessToast).not.toHaveBeenCalled();
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
