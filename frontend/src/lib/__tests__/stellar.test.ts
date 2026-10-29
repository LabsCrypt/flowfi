import { describe, it, expect } from "vitest";
import { validateNetworkId, isNetworkSupported, getHorizonUrl, getNetworkPassphrase, isValidStellarPublicKey } from "../stellar";
import type { NetworkId } from "../stellar-config";

describe("isValidStellarPublicKey", () => {
  const VALID_KEY = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";
  const INVALID_CHECKSUM = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR8";
  const MUXED_KEY = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
  const SHORT_KEY = "GABC123";
  const WRONG_PREFIX_KEY = "SABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA";

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
  it("accepts testnet short ID", () => {
    const result = validateNetworkId("testnet");
    // Type assertion to narrow the union type for access to `result.id`.
    // TypeScript's control flow doesn't narrow the union type based on
    // `expect(result.valid).toBe(true)` because `expect` is a library call.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("testnet");
  });

  it("accepts mainnet short ID", () => {
    const result = validateNetworkId("mainnet");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("mainnet");
  });

  it("accepts futurenet short ID", () => {
    const result = validateNetworkId("futurenet");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("futurenet");
  });

  it("accepts sandbox short ID", () => {
    const result = validateNetworkId("sandbox");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("sandbox");
  });

  it("accepts full testnet passphrase", () => {
    const result = validateNetworkId("Test SDF Network ; September 2015");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("testnet");
  });

  it("accepts full mainnet passphrase", () => {
    const result = validateNetworkId("Public Global Stellar Network ; September 2015");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("mainnet");
  });

  it("accepts full futurenet passphrase", () => {
    const result = validateNetworkId("Test SDF Future Network ; October 2022");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("futurenet");
  });

  it("accepts full sandbox passphrase", () => {
    const result = validateNetworkId("Standalone Network ; February 2017");
    // Type assertion to narrow the union type for access to `result.id`.
    const connected = result as { valid: true; id: NetworkId };
    expect(connected.valid).toBe(true);
    expect(connected.id).toBe("sandbox");
  });

  it("rejects empty string", () => {
    const result = validateNetworkId("");
    expect(result.valid).toBe(false);
    // The `valid` check above narrows the union type, but TypeScript's control
    // flow analysis requires an explicit type assertion to access the `error`
    // property on the `{ valid: false; error: string }` branch.
    const failureResult = (result as { valid: false; error: string });
    expect(failureResult.error).toBe("Network identifier is required");
  });

  it("rejects unsupported network", () => {
    const result = validateNetworkId("unknown-network");
    expect(result.valid).toBe(false);
    // Type assertion to narrow the union type
    const failureResult = result as { valid: false; error: string };
    expect(failureResult.error).toContain("Unsupported network");
  });

  it("rejects whitespace-only string", () => {
    const result = validateNetworkId("   ");
    expect(result.valid).toBe(false);
    // Type assertion to narrow the union type
    const failureResult = result as { valid: false; error: string };
    expect(failureResult.error).toBe("Network identifier is required");
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