import { describe, it, expect } from "vitest";
import {
  parseBatchCSV,
  validateEntry,
  generateSampleCSV,
  formatAmount,
  type BatchStreamEntry,
} from "@/lib/csv-parser";

describe("CSV Parser", () => {
  describe("parseBatchCSV", () => {
    it("parses valid CSV with multiple entries", () => {
      const csv = `recipient,amount,duration_seconds,cliff_seconds
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,1500.00,2592000,0
GBCKE5YFZTPDRGGB7FSC7GBF7S4D57GZB2CZ6BHWY5G7J74D7C236M2X,2200.50,5184000,604800`;

      const result = parseBatchCSV(csv);

      expect(result.totalRows).toBe(2);
      expect(result.validRows).toBe(2);
      expect(result.invalidRows).toBe(0);
      expect(result.entries).toHaveLength(2);
    });

    it("identifies invalid recipient addresses", () => {
      const csv = `recipient,amount,duration_seconds,cliff_seconds
INVALID_ADDRESS,100.00,86400,0
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,100.00,86400,0`;

      const result = parseBatchCSV(csv);

      expect(result.totalRows).toBe(2);
      expect(result.validRows).toBe(1);
      expect(result.invalidRows).toBe(1);
      expect(result.entries[0]!.isValid).toBe(false);
      expect(result.entries[1]!.isValid).toBe(true);
    });

    it("identifies invalid amounts", () => {
      const csv = `recipient,amount,duration_seconds,cliff_seconds
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,-100,86400,0`;

      const result = parseBatchCSV(csv);

      expect(result.totalRows).toBe(1);
      expect(result.validRows).toBe(0);
      expect(result.invalidRows).toBe(1);
      expect(result.entries[0]!.errors).toContainEqual(
        expect.objectContaining({ field: "amount" })
      );
    });

    it("identifies invalid durations", () => {
      const csv = `recipient,amount,duration_seconds,cliff_seconds
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,100.00,0,0`;

      const result = parseBatchCSV(csv);

      expect(result.totalRows).toBe(1);
      expect(result.validRows).toBe(0);
      expect(result.invalidRows).toBe(1);
      expect(result.entries[0]!.errors).toContainEqual(
        expect.objectContaining({ field: "durationSeconds" })
      );
    });

    it("handles missing columns gracefully", () => {
      const csv = `recipient,amount
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,100.00`;

      const result = parseBatchCSV(csv);

      expect(result.totalRows).toBe(0);
      expect(result.entries).toHaveLength(0);
    });

    it("handles empty CSV", () => {
      const csv = "";

      const result = parseBatchCSV(csv);

      expect(result.totalRows).toBe(0);
      expect(result.entries).toHaveLength(0);
    });

    it("calculates protocol fees correctly", () => {
      const csv = `recipient,amount,duration_seconds,cliff_seconds
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,1000.00,2592000,0`;

      const result = parseBatchCSV(csv);

      // 2.5% fee on 1000.00
      const expectedFeeUnits = BigInt(Math.round(1000 * 10 ** 7 * 250 / 10000));
      expect(result.totalProtocolFee).toBe(expectedFeeUnits);
      expect(result.totalNetDistributed).toBe(result.totalGrossAmount - result.totalProtocolFee);
    });
  });

  describe("validateEntry", () => {
    it("validates a correct entry", () => {
      const entry: BatchStreamEntry = {
        id: 1,
        recipient: "GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU",
        amount: "1000.00",
        durationSeconds: "2592000",
        cliffSeconds: "0",
      };

      const errors = validateEntry(entry);
      expect(errors).toHaveLength(0);
    });

    it("accepts federated names", () => {
      const entry: BatchStreamEntry = {
        id: 1,
        recipient: "user@stellar.org",
        amount: "1000.00",
        durationSeconds: "2592000",
        cliffSeconds: "0",
      };

      const errors = validateEntry(entry);
      expect(errors).toHaveLength(0);
    });

    it("rejects addresses that are too short", () => {
      const entry: BatchStreamEntry = {
        id: 1,
        recipient: "GBBDIOEJGZHV5GFZ",
        amount: "1000.00",
        durationSeconds: "2592000",
        cliffSeconds: "0",
      };

      const errors = validateEntry(entry);
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "recipient" })
      );
    });

    it("rejects amounts with too many decimals", () => {
      const entry: BatchStreamEntry = {
        id: 1,
        recipient: "GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU",
        amount: "1000.12345678",
        durationSeconds: "2592000",
        cliffSeconds: "0",
      };

      const errors = validateEntry(entry);
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "amount" })
      );
    });

    it("rejects cliff >= duration", () => {
      const entry: BatchStreamEntry = {
        id: 1,
        recipient: "GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU",
        amount: "1000.00",
        durationSeconds: "86400",
        cliffSeconds: "86400",
      };

      const errors = validateEntry(entry);
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "cliffSeconds" })
      );
    });
  });

  describe("generateSampleCSV", () => {
    it("generates valid CSV with header and sample rows", () => {
      const csv = generateSampleCSV();
      const lines = csv.split("\n");

      expect(lines.length).toBeGreaterThan(1);
      expect(lines[0]).toContain("recipient");
      expect(lines[0]).toContain("amount");
      expect(lines[0]).toContain("duration_seconds");
      expect(lines[0]).toContain("cliff_seconds");
    });
  });

  describe("formatAmount", () => {
    it("formats whole numbers correctly", () => {
      const amount = BigInt(1000 * 10 ** 7);
      expect(formatAmount(amount)).toBe("1000");
    });

    it("formats decimal numbers correctly", () => {
      const amount = BigInt(10005000000); // 1000.50
      expect(formatAmount(amount)).toBe("1000.5");
    });

    it("formats small numbers correctly", () => {
      const amount = BigInt(1); // 0.0000001
      expect(formatAmount(amount)).toBe("0.0000001");
    });
  });
});
