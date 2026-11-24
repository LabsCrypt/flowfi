/**
 * AmountStep regression tests (issue #1795).
 *
 * The amount step is the last gate before a stream is submitted, so its
 * public contract has to be pinned down:
 *
 *  - token decimals — Stellar assets use 7 decimals; the shared validator
 *    must accept exactly 7 fractional digits and reject 8+,
 *  - zero amount — "0" is never a valid stream amount,
 *  - excessive precision — the amount must never be silently rounded,
 *  - dependency failures — an unavailable wallet balance must degrade
 *    gracefully instead of blocking the user or showing a bogus error.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";

import { AmountStep } from "../AmountStep";
import {
  validateAmount,
  getSpendableBalance,
  XLM_BASE_RESERVE,
} from "@/lib/stream-validation";

function renderAmountStep(props: Partial<ComponentProps<typeof AmountStep>> = {}) {
  const onChange = vi.fn();
  const onSetMax = vi.fn();
  const utils = render(
    <AmountStep
      value=""
      onChange={onChange}
      token="USDC"
      onSetMax={onSetMax}
      {...props}
    />,
  );
  return { onChange, onSetMax, ...utils };
}

function getAmountInput() {
  return screen.getByLabelText(/amount/i) as HTMLInputElement;
}

describe("AmountStep — token decimals contract (issue #1795)", () => {
  it("accepts an amount with exactly seven decimal places", () => {
    expect(validateAmount("1.1234567", "1000", "USDC")).toBeNull();
    expect(validateAmount("1.1234567", "1000", "XLM")).toBeNull();
  });

  it("rejects an amount with eight decimal places instead of rounding it", () => {
    expect(validateAmount("1.12345678", "1000", "USDC")).toBe(
      "Amount exceeds maximum precision (7 decimal places)",
    );
    expect(validateAmount("1.12345678", "1000", "XLM")).toBe(
      "Amount exceeds maximum precision (7 decimal places)",
    );
  });

  it("keeps the precision limit aligned with the token's 7 decimals", () => {
    // Boundary: one digit below / one digit above the limit.
    expect(validateAmount("0.123456", "1000", "USDC")).toBeNull();
    expect(validateAmount("0.12345678", "1000", "USDC")).toBe(
      "Amount exceeds maximum precision (7 decimal places)",
    );
  });

  it("rejects a negative amount", () => {
    expect(validateAmount("-1", "1000", "USDC")).toBe(
      "Amount must be a positive number",
    );
  });

  it("surfaces the precision error through the step's error contract", () => {
    const precisionError = validateAmount("1.12345678", "1000", "USDC");
    renderAmountStep({ value: "1.12345678", error: precisionError ?? undefined });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Amount exceeds maximum precision (7 decimal places)",
    );
    expect(getAmountInput()).toHaveAttribute("aria-invalid", "true");
    expect(getAmountInput()).toHaveAttribute("aria-describedby", "amount-error");
  });
});

describe("AmountStep — zero amount (issue #1795)", () => {
  it("rejects a zero amount", () => {
    expect(validateAmount("0", "1000", "USDC")).toBe(
      "Amount must be a positive number",
    );
  });

  it("rejects an amount that is only a decimal separator", () => {
    expect(validateAmount("0.0", "1000", "USDC")).toBe(
      "Amount must be a positive number",
    );
  });

  it("rejects an empty amount", () => {
    expect(validateAmount("", "1000", "USDC")).toBe("Amount is required");
  });

  it("does not show the stream summary for a zero amount", () => {
    renderAmountStep({ value: "0" });

    expect(
      screen.queryByText(/you will stream/i),
    ).not.toBeInTheDocument();
    // A zero amount is not an over-balance error either.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getAmountInput()).toHaveAttribute("aria-invalid", "false");
  });

  it("shows the stream summary once the amount is positive", () => {
    renderAmountStep({ value: "12.5" });

    expect(screen.getByText(/you will stream/i)).toHaveTextContent(
      "You will stream 12.5 USDC to the recipient.",
    );
  });
});

describe("AmountStep — spendable balance (issue #1795)", () => {
  it("flags an amount above the wallet balance", () => {
    renderAmountStep({
      value: "500",
      availableBalance: "100",
      token: "USDC",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Amount exceeds wallet balance",
    );
    expect(getAmountInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("accepts an amount exactly equal to the spendable balance", () => {
    renderAmountStep({
      value: "100",
      availableBalance: "100",
      token: "USDC",
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getAmountInput()).toHaveAttribute("aria-invalid", "false");
  });

  it("subtracts the XLM base reserve from the displayed balance", () => {
    renderAmountStep({
      value: "",
      availableBalance: "5",
      token: "XLM",
    });

    expect(screen.getByText(/available:/i)).toHaveTextContent(
      `Available: ${5 - XLM_BASE_RESERVE} XLM`,
    );
    expect(
      screen.getByText(/is kept in reserve for network fees/i),
    ).toHaveTextContent(`${XLM_BASE_RESERVE} XLM is kept in reserve for network fees.`);
  });

  it("does not subtract the reserve for non-XLM tokens", () => {
    expect(getSpendableBalance("5", "USDC")).toBe(5);
    expect(getSpendableBalance("5", "XLM")).toBe(4);
    // A balance below the reserve leaves nothing spendable, never a negative.
    expect(getSpendableBalance("0.5", "XLM")).toBe(0);
  });

  it("does not report an over-balance error when the balance is unknown", () => {
    renderAmountStep({
      value: "1000000",
      availableBalance: null,
      token: "USDC",
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getAmountInput()).toHaveAttribute("aria-invalid", "false");
  });
});

describe("AmountStep — Max button (issue #1795)", () => {
  it("is disabled while the balance is loading", () => {
    renderAmountStep({
      availableBalance: "100",
      isBalanceLoading: true,
    });

    expect(screen.getByRole("button", { name: /max/i })).toBeDisabled();
    expect(screen.getByText(/loading balance/i)).toBeInTheDocument();
  });

  it("is disabled when no spendable balance is known", () => {
    renderAmountStep({ availableBalance: null });

    expect(screen.getByRole("button", { name: /max/i })).toBeDisabled();
  });

  it("is enabled and calls onSetMax when a spendable balance is known", () => {
    const { onSetMax } = renderAmountStep({ availableBalance: "100" });

    const maxButton = screen.getByRole("button", { name: /max/i });
    expect(maxButton).toBeEnabled();

    fireEvent.click(maxButton);
    expect(onSetMax).toHaveBeenCalledTimes(1);
  });

  it("is disabled when no onSetMax handler is provided", () => {
    render(
      <AmountStep value="" onChange={vi.fn()} token="USDC" availableBalance="100" />,
    );

    expect(screen.getByRole("button", { name: /max/i })).toBeDisabled();
  });
});

describe("AmountStep — dependency failures (issue #1795)", () => {
  it("shows the balance error as a non-blocking status message", () => {
    renderAmountStep({
      value: "10",
      availableBalance: null,
      balanceError: "Unable to fetch wallet balance right now.",
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Unable to fetch wallet balance right now.",
    );
    // A dependency failure must not be reported as a validation error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getAmountInput()).toHaveAttribute("aria-invalid", "false");
  });

  it("hides the balance error once a validation error is present", () => {
    renderAmountStep({
      value: "10",
      availableBalance: null,
      balanceError: "Unable to fetch wallet balance right now.",
      error: "Amount must be a positive number",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Amount must be a positive number",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("forwards every keystroke to onChange", () => {
    const { onChange } = renderAmountStep({ value: "" });

    fireEvent.change(getAmountInput(), { target: { value: "42.5" } });
    expect(onChange).toHaveBeenCalledWith("42.5");
  });
});
