import { describe, it, expect } from "vitest";
import { validateAmountInput } from "./amount";

// Shared validation used by TopUpModal and the stream-details top-up (#1208).
describe("validateAmountInput precision", () => {
  it("rejects over-precise input instead of letting it be rounded", () => {
    expect(validateAmountInput("1.12345678901", 7)).toBe("Amount cannot have more than 7 decimal places");
  });

  it("accepts exactly seven decimals", () => {
    expect(validateAmountInput("1.1234567", 7)).toBeNull();
  });

  it("rejects empty, zero and malformed input", () => {
    expect(validateAmountInput("", 7)).toBe("Amount is required");
    expect(validateAmountInput("0", 7)).toBe("Amount must be greater than 0");
    expect(validateAmountInput("1e5", 7)).toBe("Please enter a valid number");
  });
});
