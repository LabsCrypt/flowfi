import { describe, it, expect } from "vitest";
import {
  toWalletErrorMessage,
  shortenPublicKey,
  formatNetwork,
  isExpectedNetwork,
  SUPPORTED_WALLETS,
  FreighterNotInstalledError,
} from "../lib/wallet";

describe("toWalletErrorMessage", () => {
  it("maps user rejection patterns to friendly message", () => {
    const rejectionMessages = [
      "Request rejected",
      "User declined",
      "Access denied by user",
      "Connection canceled",
      "User cancelled the request",
      "Popup closed by user",
      "Window closed",
    ];

    for (const msg of rejectionMessages) {
      expect(toWalletErrorMessage(new Error(msg))).toBe(
        "You rejected the connection request. Try again when ready.",
      );
    }
  });

  it("returns specialized message for FreighterNotInstalledError", () => {
    const err = new FreighterNotInstalledError();
    expect(toWalletErrorMessage(err)).toBe(err.message);
  });

  it("returns original message for standard Error", () => {
    const err = new Error("Something broke");
    expect(toWalletErrorMessage(err)).toBe("Something broke");
  });

  it("returns fallback for null error", () => {
    expect(toWalletErrorMessage(null)).toBe(
      "Wallet connection failed. Please try again.",
    );
  });

  it("returns fallback for undefined error", () => {
    expect(toWalletErrorMessage(undefined)).toBe(
      "Wallet connection failed. Please try again.",
    );
  });

  it("returns fallback for number error", () => {
    expect(toWalletErrorMessage(42)).toBe(
      "Wallet connection failed. Please try again.",
    );
  });

  it("maps network timeout to original message (not rejection)", () => {
    expect(toWalletErrorMessage("network timeout")).toBe("network timeout");
  });

  it("maps string denial to rejection message", () => {
    expect(toWalletErrorMessage("user denied")).toBe(
      "You rejected the connection request. Try again when ready.",
    );
  });

  it("maps access denied to rejection message", () => {
    expect(toWalletErrorMessage("Access denied by user")).toBe(
      "You rejected the connection request. Try again when ready.",
    );
  });
});

describe("shortenPublicKey", () => {
  it("shortens a long key", () => {
    const key = "GAAAAAAA" + "A".repeat(50);
    const short = shortenPublicKey(key);
    expect(short).toContain("...");
    expect(short.startsWith(key.slice(0, 7))).toBe(true);
    expect(short.endsWith(key.slice(-7))).toBe(true);
  });

  it("returns short keys unchanged", () => {
    const short = "GCXYZ";
    expect(shortenPublicKey(short)).toBe(short);
  });

  it("returns empty string unchanged", () => {
    expect(shortenPublicKey("")).toBe("");
  });

  it("returns single character unchanged", () => {
    expect(shortenPublicKey("G")).toBe("G");
  });
});

describe("formatNetwork", () => {
  it("maps mainnet passphrase to 'Mainnet'", () => {
    expect(formatNetwork("Public Global Stellar Network ; September 2015")).toBe(
      "Mainnet",
    );
  });

  it("maps 'mainnet' to 'Mainnet'", () => {
    expect(formatNetwork("mainnet")).toBe("Mainnet");
  });

  it("maps testnet passphrase to 'Testnet'", () => {
    expect(formatNetwork("Test SDF Network ; September 2015")).toBe("Testnet");
  });

  it("maps 'testnet' to 'Testnet'", () => {
    expect(formatNetwork("testnet")).toBe("Testnet");
  });

  it("maps 'stellar testnet' to 'Testnet'", () => {
    expect(formatNetwork("stellar testnet")).toBe("Testnet");
  });

  it("returns original for unknown networks", () => {
    expect(formatNetwork("custom-network")).toBe("custom-network");
  });

  it("maps 'Public' to 'Mainnet'", () => {
    expect(formatNetwork("Public")).toBe("Mainnet");
  });

  it("maps 'Test' to 'Testnet'", () => {
    expect(formatNetwork("Test")).toBe("Testnet");
  });

  it("maps 'sdf' to 'Testnet'", () => {
    expect(formatNetwork("sdf")).toBe("Testnet");
  });
});

describe("isExpectedNetwork", () => {
  it("returns true when session matches expected network (TESTNET default)", () => {
    expect(isExpectedNetwork("Test SDF Network ; September 2015")).toBe(true);
    expect(isExpectedNetwork("testnet")).toBe(true);
  });

  it("returns false when session does not match expected network", () => {
    expect(isExpectedNetwork("Public Global Stellar Network ; September 2015")).toBe(
      false,
    );
    expect(isExpectedNetwork("mainnet")).toBe(false);
  });
});

describe("SUPPORTED_WALLETS", () => {
  it("contains freighter", () => {
    expect(SUPPORTED_WALLETS.find((w) => w.id === "freighter")).toBeDefined();
  });

  it("each entry has required fields", () => {
    for (const w of SUPPORTED_WALLETS) {
      expect(w.id).toBeTruthy();
      expect(w.name).toBeTruthy();
      expect(w.badge).toBeTruthy();
      expect(w.description).toBeTruthy();
    }
  });
});