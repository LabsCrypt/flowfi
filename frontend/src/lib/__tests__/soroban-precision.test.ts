import { describe, it, expect } from "vitest";
import { toBaseUnits, fromBaseUnits, toDurationSeconds, SorobanCallError } from "../soroban";

describe("Soroban Amount Precision and Boundaries", () => {
  describe("toBaseUnits", () => {
    it("converts standard decimal amounts correctly", () => {
      expect(toBaseUnits("1.5", 7)).toBe(BigInt(15000000));
      expect(toBaseUnits("100", 7)).toBe(BigInt(1000000000));
    });

    it("handles custom token decimals (e.g. 6 decimals for USDC)", () => {
      expect(toBaseUnits("123.456789", 6)).toBe(BigInt(123456789));
      expect(toBaseUnits("1", 0)).toBe(BigInt(1));
    });

    it("throws SorobanCallError with InvalidAmount for zero or negative or non-numeric values", () => {
      expect(() => toBaseUnits("0", 7)).toThrowError(SorobanCallError);
      expect(() => toBaseUnits("-5", 7)).toThrowError(SorobanCallError);
      expect(() => toBaseUnits("abc", 7)).toThrowError(SorobanCallError);
    });
  });

  describe("fromBaseUnits", () => {
    it("converts base units to readable string with trailing zero trimming", () => {
      expect(fromBaseUnits(BigInt(15000000), 7)).toBe("1.5");
      expect(fromBaseUnits(BigInt(1000000000), 7)).toBe("100");
      expect(fromBaseUnits(BigInt(123456789), 6)).toBe("123.456789");
    });

    it("accepts string or bigint representation", () => {
      expect(fromBaseUnits("15000000", 7)).toBe("1.5");
    });
  });

  describe("toDurationSeconds boundaries", () => {
    it("converts various duration units correctly", () => {
      expect(toDurationSeconds("1", "seconds")).toBe(BigInt(1));
      expect(toDurationSeconds("2", "minutes")).toBe(BigInt(120));
      expect(toDurationSeconds("1", "hours")).toBe(BigInt(3600));
      expect(toDurationSeconds("1", "days")).toBe(BigInt(86400));
      expect(toDurationSeconds("1", "weeks")).toBe(BigInt(604800));
      expect(toDurationSeconds("1", "months")).toBe(BigInt(2592000));
    });

    it("rejects non-positive or invalid durations", () => {
      expect(() => toDurationSeconds("0", "days")).toThrowError(SorobanCallError);
      expect(() => toDurationSeconds("-10", "hours")).toThrowError(SorobanCallError);
      expect(() => toDurationSeconds("invalid", "seconds")).toThrowError(SorobanCallError);
    });
  });
});
