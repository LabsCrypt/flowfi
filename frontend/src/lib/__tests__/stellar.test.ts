import { describe, it, expect } from "vitest";
import {
  validateNetworkId,
  isNetworkSupported,
  getHorizonUrl,
  getNetworkPassphrase,
  isValidStellarPublicKey,
} from "../stellar";

const MUXED_KEY = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
const SHORT_KEY = "GABC123";
const WRONG_PREFIX_KEY = "SABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA";

describe("isValidStellarPublicKey", () => {
  const VALID_KEY = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";
  const INVALID_CHECKSUM = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR8";

  it("accepts a valid G-prefixed Ed25519 public key", () => {
    expect(isValidStellarPublicKey(VALID_KEY)).toBe(true);
  });

  it("rejects a key with a tampered checksum", () => {
    expect(isValidStellarPublicKey(INVALID_CHECKSUM)).toBe(false);
  });

  it("rejects a muxed account address (M...)", () => {
    expect(isValidStellarPublicKey(MUXED_KEY)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidStellarPublicKey("")).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(isValidStellarPublicKey(SHORT_KEY)).toBe(false);
  });

  it("rejects a key with a wrong prefix", () => {
    expect(isValidStellarPublicKey(WRONG_PREFIX_KEY)).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidStellarPublicKey(`  ${VALID_KEY}  `)).toBe(true);
    expect(isValidStellarPublicKey("  ")).toBe(false);
  });
});

describe("validateNetworkId", () => {
  const validNetwork = (value: string, expectedId: string) =>
    expect(validateNetworkId(value)).toEqual({ valid: true, id: expectedId });

  it("accepts testnet short ID", () => {
    validNetwork("testnet", "testnet");
  });

  it("accepts mainnet short ID", () => {
    validNetwork("mainnet", "mainnet");
  });

  it("accepts futurenet short ID", () => {
    validNetwork("futurenet", "futurenet");
  });

  it("accepts sandbox short ID", () => {
    validNetwork("sandbox", "sandbox");
  });

  it("accepts full testnet passphrase", () => {
    validNetwork("Test SDF Network ; September 2015", "testnet");
  });

  it("accepts full mainnet passphrase", () => {
    validNetwork("Public Global Stellar Network ; September 2015", "mainnet");
  });

  it("accepts full futurenet passphrase", () => {
    validNetwork("Test SDF Future Network ; October 2022", "futurenet");
  });

  it("accepts full sandbox passphrase", () => {
    validNetwork("Standalone Network ; February 2017", "sandbox");
  });

  it("rejects empty string", () => {
    expect(validateNetworkId("")).toEqual({
      valid: false,
      error: "Network identifier is required",
    });
  });

  it("rejects unsupported network", () => {
    const result = validateNetworkId("unknown-network");
    if (result.valid) {
      throw new Error("expected 'unknown-network' network to be rejected");
    }
    expect(result.error).toContain("Unsupported network");
  });

  it("rejects whitespace-only string", () => {
    expect(validateNetworkId("   ")).toEqual({
      valid: false,
      error: "Network identifier is required",
    });
  });
});

describe("isNetworkSupported", () => {
  it("returns true for testnet", () => {
    expect(isNetworkSupported("testnet")).toBe(true);
  });

  it("returns true for mainnet", () => {
    expect(isNetworkSupported("mainnet")).toBe(true);
  });

  it("returns true for futurenet", () => {
    expect(isNetworkSupported("futurenet")).toBe(true);
  });

  it("returns true for sandbox", () => {
    expect(isNetworkSupported("sandbox")).toBe(true);
  });

  it("returns false for unsupported network", () => {
    expect(isNetworkSupported("unknown")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isNetworkSupported("")).toBe(false);
  });
});

describe("getHorizonUrl", () => {
  it("returns testnet Horizon URL", () => {
    expect(getHorizonUrl("testnet")).toBe("https://horizon-testnet.stellar.org");
  });

  it("returns mainnet Horizon URL", () => {
    expect(getHorizonUrl("mainnet")).toBe("https://horizon.stellar.org");
  });

  it("returns futurenet Horizon URL", () => {
    expect(getHorizonUrl("futurenet")).toBe("https://horizon-futurenet.stellar.org");
  });

  it("returns sandbox Horizon URL", () => {
    expect(getHorizonUrl("sandbox")).toBe("http://localhost:8000");
  });

  it("returns sandbox fallback for unknown network", () => {
    expect(getHorizonUrl("unknown")).toBe("http://localhost:8000");
  });

  it("returns testnet URL for full passphrase", () => {
    expect(getHorizonUrl("Test SDF Network ; September 2015")).toBe("https://horizon-testnet.stellar.org");
  });
});

describe("getNetworkPassphrase", () => {
  it("returns testnet passphrase", () => {
    expect(getNetworkPassphrase("testnet")).toBe("Test SDF Network ; September 2015");
  });

  it("returns mainnet passphrase", () => {
    expect(getNetworkPassphrase("mainnet")).toBe("Public Global Stellar Network ; September 2015");
  });

  it("returns futurenet passphrase", () => {
    expect(getNetworkPassphrase("futurenet")).toBe("Test SDF Future Network ; October 2022");
  });

  it("returns sandbox passphrase", () => {
    expect(getNetworkPassphrase("sandbox")).toBe("Standalone Network ; February 2017");
  });

  it("returns testnet passphrase for full passphrase", () => {
    expect(getNetworkPassphrase("Test SDF Network ; September 2015")).toBe("Test SDF Network ; September 2015");
  });

  it("returns testnet passphrase for unknown network (fallback)", () => {
    expect(getNetworkPassphrase("unknown")).toBe("Test SDF Network ; September 2015");
  });
});