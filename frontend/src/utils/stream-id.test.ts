import { describe, expect, it } from "vitest";

import { isOnChainStreamId, parseStreamId } from "./stream-id";

// A Stream carries two identifiers — the on-chain u64 and the database UUID —
// and the batch claim used to coerce whichever it got with
// BigInt(id.replace(/\D/g, "")), which turns a UUID into 0n or a truncated
// number and submits a withdrawal against a stream that is not on screen
// (#1883). These are the shapes that used to slip through.
describe("parseStreamId", () => {
  it("accepts the on-chain id shapes", () => {
    expect(parseStreamId("7")).toBe(7n);
    expect(parseStreamId(" 42 ")).toBe(42n);
    expect(parseStreamId(7)).toBe(7n);
    expect(parseStreamId(7n)).toBe(7n);
    expect(parseStreamId("0")).toBe(0n);
    expect(parseStreamId("18446744073709551615")).toBe(18446744073709551615n);
  });

  it("rejects a UUID instead of trimming it to a number", () => {
    expect(parseStreamId("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toBeNull();
    expect(parseStreamId("stream-12")).toBeNull();
  });

  it("rejects everything else a caller could pass by mistake", () => {
    for (const value of ["", "  ", "-1", "1.5", "0x1f", "1e3", null, undefined]) {
      expect(parseStreamId(value)).toBeNull();
    }
    expect(parseStreamId(-1)).toBeNull();
    expect(parseStreamId(1.5)).toBeNull();
    expect(parseStreamId(-1n)).toBeNull();
  });

  it("answers isOnChainStreamId the same way", () => {
    expect(isOnChainStreamId("12")).toBe(true);
    expect(isOnChainStreamId("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toBe(false);
  });
});
