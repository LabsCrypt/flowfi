import { describe, it, expect } from "vitest";
import { parseBatchCSV, replaceBatchCSVRow } from "@/lib/csv-parser";

const A = "GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU";
const B = "GBCKE5YFZTPDRGGB7FSC7GBF7S4D57GZB2CZ6BHWY5G7J74D7C236M2X";
const C = "GCBA6C5YC3FXYC4KC7LC5MC2P3C4R5C6C7U4VC5WC2X3YC2Z3AC4BC5C";

describe("replaceBatchCSVRow", () => {
  const csv = [
    "amount,recipient,duration_seconds,cliff_seconds",
    `100,${A},86400,0`,
    `200.5,${B},172800,3600`,
    `300,${C},259200,0`,
  ].join("\n");

  it("keeps edited values in their header-mapped columns and leaves other rows intact", () => {
    const out = replaceBatchCSVRow(csv, 2, {
      recipient: A,
      amount: "999",
      durationSeconds: "500000",
      cliffSeconds: "10",
    });
    expect(out.split("\n")[0]).toBe("amount,recipient,duration_seconds,cliff_seconds");
    const before = parseBatchCSV(csv).entries;
    const after = parseBatchCSV(out).entries;
    expect(after).toHaveLength(3);
    expect(after[1]).toMatchObject({
      recipient: A,
      amount: "999",
      durationSeconds: "500000",
      cliffSeconds: "10",
      isValid: true,
    });
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
  });

  it("preserves extra columns and escapes fields", () => {
    const withExtra = `memo,recipient,amount,duration\n"a, b",${A},1,100\nplain,${B},2,200`;
    const out = replaceBatchCSVRow(withExtra, 1, {
      recipient: C,
      amount: "5",
      durationSeconds: "300",
      cliffSeconds: "0",
    });
    expect(out.split("\n")[1]).toBe(`"a, b",${C},5,300`);
    expect(out.split("\n")[2]).toBe("plain," + B + ",2,200");
    expect(parseBatchCSV(out).entries[0]?.recipient).toBe(C);
  });

  it("quotes edited values containing commas or quotes", () => {
    const out = replaceBatchCSVRow(csv, 1, {
      recipient: 'a,"b"@x.io',
      amount: "1",
      durationSeconds: "10",
      cliffSeconds: "0",
    });
    expect(parseBatchCSV(out).entries[0]?.recipient).toBe('a,"b"@x.io');
  });

  it("returns the input unchanged for an unknown row id", () => {
    const v = { recipient: A, amount: "1", durationSeconds: "1", cliffSeconds: "0" };
    expect(replaceBatchCSVRow(csv, 0, v)).toBe(csv);
    expect(replaceBatchCSVRow(csv, 9, v)).toBe(csv);
  });
});
