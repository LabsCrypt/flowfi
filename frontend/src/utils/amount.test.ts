import { describe, it, expect } from "vitest";
import {
  parseAmount,
  formatAmount,
  validateAmountInput,
  hasValidPrecision,
} from "./amount";

describe("parseAmount edge cases (negative, excessive precision, rounding)", () => {
  it("handles negative amounts correctly", () => {
    // parseAmount treats negative values as invalid/zero (returns 0n)
    expect(parseAmount("-1.5", 7)).toBe(0n);
    expect(parseAmount("-0", 7)).toBe(0n);
  });

  it("handles excessive precision by truncating extra decimal places", () => {
    // 7 decimals max, input has 9
    expect(parseAmount("1.123456789", 7)).toBe(11234567n);
    expect(parseAmount("0.000000123", 7)).toBe(1n);
  });

  it("handles halfway rounding / boundary inputs correctly", () => {
    // parseAmount currently floors/truncates excess precision rather than rounding
    expect(parseAmount("1.12345674", 7)).toBe(11234567n);
    expect(parseAmount("1.12345676", 7)).toBe(11234567n);
  });

  it("round-trips positive boundary values properly", () => {
    const val = 1234567n;
    const formatted = formatAmount(val, 7);
    expect(parseAmount(formatted, 7)).toBe(val);
  });
});

describe("amount parser locale, exponent, whitespace, and empty strings", () => {
  describe("parseAmount with locale and edge inputs", () => {
    it("handles empty and whitespace-only strings", () => {
      expect(parseAmount("", 7)).toBe(0n);
      expect(parseAmount("   ", 7)).toBe(0n);
      expect(parseAmount("\t\n", 7)).toBe(0n);
    });

    it("rejects or handles exponent notation correctly", () => {
      // Exponent notation like '1e5' is non-standard for strict decimal input parsers unless handled,
      // parseAmount regex /^[\d]*\.?[\d]*$/ rejects 'e'. Verify it returns 0n.
      expect(parseAmount("1e5", 7)).toBe(0n);
      expect(parseAmount("1.5E-2", 7)).toBe(0n);
    });

    it("handles locale separators (comma vs dot) and invalid punctuation", () => {
      // parseAmount expects dot (.) as decimal separator. Commas should be treated as non-digits / invalid formats.
      expect(parseAmount("1,234", 7)).toBe(0n);
      expect(parseAmount("1.234.56", 7)).toBe(0n);
    });

    it("handles leading and trailing whitespace around valid numbers", () => {
      expect(parseAmount("  123.45  ", 7)).toBe(1234500000n);
      expect(parseAmount("\t0.1\n", 7)).toBe(1000000n);
    });
  });

  describe("validateAmountInput with exponent and locale inputs", () => {
    it("rejects exponent notation with valid error message", () => {
      expect(validateAmountInput("1e5", 7)).toBe("Please enter a valid number");
      expect(validateAmountInput("1.2e-3", 7)).toBe("Please enter a valid number");
    });

    it("rejects locale comma separators", () => {
      expect(validateAmountInput("1,234.56", 7)).toBe("Please enter a valid number");
      expect(validateAmountInput("1,5", 7)).toBe("Please enter a valid number");
    });

    it("validates whitespace and empty strings", () => {
      expect(validateAmountInput("", 7)).toBe("Amount is required");
      expect(validateAmountInput("   ", 7)).toBe("Amount is required");
      expect(validateAmountInput("0", 7)).toBe("Amount must be greater than 0");
    });
  });

  describe("formatAmount and edge cases", () => {
    it("formats zero and boundary bigints correctly", () => {
      expect(formatAmount(0n, 7)).toBe("0");
      expect(formatAmount(1n, 7)).toBe("0.0000001");
      expect(formatAmount(10000000n, 7)).toBe("1");
    });
  });

  describe("hasValidPrecision with exponents and edge cases", () => {
    it("handles empty and whitespace correctly", () => {
      expect(hasValidPrecision("", 7)).toBe(true);
      expect(hasValidPrecision("   ", 7)).toBe(true);
    });

    it("rejects exponential notation in precision check", () => {
      expect(hasValidPrecision("1e-5", 7)).toBe(false);
    });
  });
});
