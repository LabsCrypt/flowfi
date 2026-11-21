import { describe, expect, it } from "vitest";
import { TOKEN_ADDRESSES } from "./soroban";
import { resolveTokenLabel, resolveTokenSymbol } from "./tokens";

describe("token symbol resolution", () => {
  it("resolves every address in TOKEN_ADDRESSES to its symbol", () => {
    for (const [symbol, address] of Object.entries(TOKEN_ADDRESSES)) {
      expect(resolveTokenSymbol(address)).toBe(symbol);
      expect(resolveTokenLabel(address)).toBe(symbol);
    }
  });

  it("returns undefined for unknown or empty addresses", () => {
    expect(resolveTokenSymbol("CUNKNOWNTOKENADDRESS000000000000")).toBeUndefined();
    expect(resolveTokenSymbol(undefined)).toBeUndefined();
    expect(resolveTokenSymbol("")).toBeUndefined();
  });

  it("falls back to a shortened address label for unknown tokens", () => {
    expect(resolveTokenLabel("CUNKNOWNTOKENADDRESS0000000000WXYZ")).toBe("CUNKNO...WXYZ");
  });
});
