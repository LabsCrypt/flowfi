import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOKEN_GRADIENT_STOPS,
  MIN_INITIALS_CONTRAST,
  getTokenGradient,
  getTokenGradientStops,
  getTokenInitials,
  hashString,
  whiteContrastRatio,
} from "./tokenAvatar";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN";
const EURC = "CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY";

describe("getTokenInitials", () => {
  it("takes the first two characters, uppercased", () => {
    expect(getTokenInitials("USDC")).toBe("US");
    expect(getTokenInitials("xlm")).toBe("XL");
  });

  it("keeps a single-character symbol as one character", () => {
    expect(getTokenInitials("x")).toBe("X");
  });

  it("falls back to '?' for empty or missing symbols", () => {
    expect(getTokenInitials("")).toBe("?");
    expect(getTokenInitials("   ")).toBe("?");
    expect(getTokenInitials(undefined)).toBe("?");
    expect(getTokenInitials(null)).toBe("?");
  });

  it("trims leading and trailing whitespace", () => {
    expect(getTokenInitials("  eurc ")).toBe("EU");
  });

  it("does not split emoji or multi-code-point characters", () => {
    expect(getTokenInitials("🚀moon")).toBe("🚀M");
    expect(getTokenInitials("🚀🌕")).toBe("🚀🌕");
    expect(getTokenInitials("🇺🇸usd")).toBe("🇺🇸U");
  });
});

describe("getTokenGradient", () => {
  it("is deterministic for the same address", () => {
    expect(getTokenGradient(USDC)).toBe(getTokenGradient(USDC));
    expect(getTokenGradient(` ${USDC.toLowerCase()} `)).toBe(getTokenGradient(USDC));
  });

  it("produces different gradients for different addresses", () => {
    const gradients = new Set([USDC, XLM, EURC].map((address) => getTokenGradient(address)));
    expect(gradients.size).toBe(3);
  });

  it("returns the exact expected CSS for known addresses", () => {
    expect(getTokenGradient(USDC)).toBe(
      "linear-gradient(165deg, hsl(270, 65%, 50%), hsl(353, 65%, 42%))",
    );
    expect(getTokenGradient(XLM)).toBe(
      "linear-gradient(180deg, hsl(124, 65%, 32%), hsl(188, 65%, 26%))",
    );
    expect(getTokenGradient(EURC)).toBe(
      "linear-gradient(165deg, hsl(2, 65%, 50%), hsl(37, 65%, 29%))",
    );
  });

  it("falls back to the symbol when there is no address, then to a neutral default", () => {
    expect(getTokenGradient(null, "usdc")).toBe(getTokenGradient("USDC"));
    expect(getTokenGradient("   ", "usdc")).toBe(getTokenGradient("USDC"));
    expect(getTokenGradientStops(undefined, "")).toEqual(DEFAULT_TOKEN_GRADIENT_STOPS);
    expect(getTokenGradient()).toBe(
      "linear-gradient(135deg, hsl(215, 20%, 40%), hsl(215, 25%, 27%))",
    );
  });

  it("uses a stable 32-bit FNV-1a hash", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
    expect(hashString("foobar")).toBe(0xbf9cf968);
  });
});

describe("gradient contrast", () => {
  it("keeps white initials at >= 4.5:1 on both stops across 2000 seeds", () => {
    const hues = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const { from, to } = getTokenGradientStops(`SEED-${i}`);
      expect(whiteContrastRatio(from)).toBeGreaterThanOrEqual(MIN_INITIALS_CONTRAST);
      expect(whiteContrastRatio(to)).toBeGreaterThanOrEqual(MIN_INITIALS_CONTRAST);
      hues.add(from.h).add(to.h);
    }
    // The sample must actually exercise the whole colour wheel.
    expect(hues.size).toBe(360);
  });

  it("keeps the neutral default gradient readable too", () => {
    expect(whiteContrastRatio(DEFAULT_TOKEN_GRADIENT_STOPS.from)).toBeGreaterThanOrEqual(
      MIN_INITIALS_CONTRAST,
    );
    expect(whiteContrastRatio(DEFAULT_TOKEN_GRADIENT_STOPS.to)).toBeGreaterThanOrEqual(
      MIN_INITIALS_CONTRAST,
    );
  });

  it("matches known WCAG reference values", () => {
    // Pure black and white backgrounds bound the ratio at 21:1 and 1:1.
    expect(whiteContrastRatio({ h: 0, s: 0, l: 0 })).toBeCloseTo(21, 5);
    expect(whiteContrastRatio({ h: 0, s: 0, l: 100 })).toBeCloseTo(1, 5);
  });
});
