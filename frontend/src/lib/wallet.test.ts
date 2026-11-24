/**
 * Unit tests for lib/wallet.ts (issue #1775).
 *
 * The wallet provider (@stellar/freighter-api) is fully mocked — no real
 * extension, browser or network is involved. Mocks are reset before every
 * test so cases are deterministic and order-independent.
 *
 * Error shapes used here mirror the real Freighter v6 contract:
 * `getAddress()`/`isConnected()`/`getNetworkDetails()` resolve with results
 * that may carry an `error` (string or `{ code, message }` object), which is
 * exactly how the real extension replies over its postMessage channel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectWallet,
  FreighterNotInstalledError,
  STELLAR_NETWORK,
  toWalletErrorMessage,
  type WalletId,
  type WalletSession,
} from "./wallet";
import {
  getAddress,
  getNetworkDetails,
  isConnected,
  setAllowed,
} from "@stellar/freighter-api";

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(),
  setAllowed: vi.fn(),
  getAddress: vi.fn(),
  getNetworkDetails: vi.fn(),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

type AddressResult = Awaited<ReturnType<typeof getAddress>>;

const PUBLIC_KEY = "GB5P5GY25PGHPN4DG2XSQLWCUHTFUK2GDZ75IWB7KZV3RKBVH33GZ32U";
const SECOND_PUBLIC_KEY = "GDBX55OJUOXRSTWICUESBZAHSMJNFWZ57NEEPVN74BXKH7OGZV23RYCG";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Network label the module falls back to when provider details are unusable. */
const APP_NETWORK_LABEL = STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet";

/**
 * The module resolves bridge wallets through `window[walletId]`. Helper keeps
 * access type-safe under `noUncheckedIndexedAccess` and allows per-test setup.
 */
const windowBridge = (id: WalletId, bridge: unknown) => {
  (window as unknown as Record<string, unknown>)[id] = bridge;
};

const removeBridge = (...ids: WalletId[]) => {
  const registry = window as unknown as Record<string, unknown>;
  for (const id of ids) delete registry[id];
};

/** Harmless valid getNetworkDetails payload (no error field). */
const networkDetails = (networkPassphrase: string) => ({
  network: networkPassphrase.includes("public") ? "MAINNET" : "TESTNET",
  networkUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase,
});

const userRejectionMessage = "You rejected the connection request. Try again when ready.";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  removeBridge("albedo", "xbull", "hana", "walletconnect");
  vi.clearAllMocks();
});

// ── Successful connection ────────────────────────────────────────────────────

describe("connectWallet – successful Freighter connection", () => {
  it("returns the account the provider gave, marked as a real (non-mocked) session", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });
    vi.mocked(getNetworkDetails).mockResolvedValue(networkDetails(TESTNET_PASSPHRASE));

    const session: WalletSession = await connectWallet("freighter");

    expect(session).toEqual({
      walletId: "freighter",
      walletName: "Freighter",
      publicKey: PUBLIC_KEY,
      connectedAt: expect.any(String),
      network: "Testnet",
      mocked: false,
    });
    // connectedAt is a usable timestamp (not a placeholder).
    expect(Number.isNaN(Date.parse(session.connectedAt))).toBe(false);
  });

  it("grants access before asking for the address, and only asks once", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });
    vi.mocked(getNetworkDetails).mockResolvedValue(networkDetails(TESTNET_PASSPHRASE));

    await connectWallet("freighter");

    expect(isConnected).toHaveBeenCalledTimes(1);
    expect(setAllowed).toHaveBeenCalledTimes(1);
    expect(getAddress).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setAllowed).mock.invocationCallOrder[0] as number).toBeLessThan(
      vi.mocked(getAddress).mock.invocationCallOrder[0] as number,
    );
  });

  it("labels the session Mainnet when the provider reports a public network", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });
    vi.mocked(getNetworkDetails).mockResolvedValue(networkDetails(MAINNET_PASSPHRASE));

    expect((await connectWallet("freighter")).network).toBe("Mainnet");
  });

  it("labels the session Other for an unrecognised provider network passphrase", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });
    vi.mocked(getNetworkDetails).mockResolvedValue(
      networkDetails("PWNX Private Network ; Custom Deployment"),
    );

    expect((await connectWallet("freighter")).network).toBe("Other");
  });

  it("prefers the bridge publicKey over address for bridge wallets", async () => {
    windowBridge("albedo", {
      connect: vi.fn(async () => ({ publicKey: PUBLIC_KEY, address: SECOND_PUBLIC_KEY })),
    });

    const session = await connectWallet("albedo");

    expect(session).toEqual({
      walletId: "albedo",
      walletName: "Albedo",
      publicKey: PUBLIC_KEY,
      connectedAt: expect.any(String),
      network: APP_NETWORK_LABEL,
      mocked: false,
    });
  });

  it("falls back to the bridge address when no publicKey is returned", async () => {
    windowBridge("albedo", {
      connect: vi.fn(async () => ({ address: SECOND_PUBLIC_KEY })),
    });

    const session = await connectWallet("albedo");

    expect(session.publicKey).toBe(SECOND_PUBLIC_KEY);
    expect(session.walletName).toBe("Albedo");
  });
});

// ── User rejection ───────────────────────────────────────────────────────────

describe("connectWallet – user rejection of the connection request", () => {
  it("surfaces the provider's decline message as a thrown error, not a session", async () => {
    // String error is the shape @stellar/freighter-api's own test suite uses
    // for extension replies carrying an error.
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({
      address: "",
      error: "The user rejected the request",
    } as unknown as AddressResult);

    await expect(connectWallet("freighter")).rejects.toThrow(
      "The user rejected the request",
    );
  });

  it("still fails the connection when the decline arrives as the typed FreighterApiError object", async () => {
    // Official v6 typings (and the e2e postMessage mock) send errors as
    // `{ code, message }` objects. The contract under test: the connection
    // must fail rather than resolve with a stale or empty account.
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({
      address: "",
      error: { code: -3, message: "The user rejected the request" },
    });

    await expect(connectWallet("freighter")).rejects.toThrow(Error);
    // The provider data must not leak through as a connected session.
    await expect(connectWallet("freighter")).rejects.not.toMatchObject({
      walletId: "freighter",
    });
  });

  it("reports the rejection to the UI through toWalletErrorMessage", async () => {
    expect(
      toWalletErrorMessage(new Error("The user rejected the request")),
    ).toBe(userRejectionMessage);
  });

  it("recognises declined/aborted connection flows from other provider wording", () => {
    expect(toWalletErrorMessage(new Error("Access denied by user"))).toBe(
      userRejectionMessage,
    );
    expect(toWalletErrorMessage(new Error("Authorization was cancelled"))).toBe(
      userRejectionMessage,
    );
    expect(toWalletErrorMessage(new Error("The user aborted the flow"))).toBe(
      userRejectionMessage,
    );
  });

  it("propagates a bridge wallet's connect() rejection untouched", async () => {
    windowBridge("albedo", {
      connect: vi.fn(async () => {
        throw new Error("User denied access");
      }),
    });

    await expect(connectWallet("albedo")).rejects.toThrow("User denied access");
    expect(toWalletErrorMessage(new Error("User denied access"))).toBe(
      userRejectionMessage,
    );
  });
});

// ── Wallet unavailable ───────────────────────────────────────────────────────

describe("connectWallet – wallet not installed / provider unavailable", () => {
  it("throws FreighterNotInstalledError when the extension reports not connected", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: false });

    await expect(connectWallet("freighter")).rejects.toThrow(
      FreighterNotInstalledError,
    );
    await expect(connectWallet("freighter")).rejects.toThrow(
      "Freighter extension is not installed. Please install it from freighter.app.",
    );
  });

  it("keeps the specialised install message for FreighterNotInstalledError", () => {
    const error = new FreighterNotInstalledError();
    expect(toWalletErrorMessage(error)).toBe(
      "Freighter extension is not installed. Please install it from freighter.app.",
    );
    // The specialised name is what the UI switches on.
    expect(toWalletErrorMessage(error)).not.toBe(userRejectionMessage);
  });

  it("propagates an unexpected provider error during the availability check", async () => {
    vi.mocked(isConnected).mockRejectedValue(new Error("provider bridge unavailable"));

    await expect(connectWallet("freighter")).rejects.toThrow(
      "provider bridge unavailable",
    );
  });

  it("rejects bridge wallets that are not installed at all", async () => {
    // Nothing is set on `window` — the test environment has no wallet.
    await expect(connectWallet("albedo")).rejects.toThrow(
      "Albedo is not installed or available.",
    );
  });

  it("does not treat a non-object bridge value as an installed wallet", async () => {
    windowBridge("albedo", "truthy-but-not-a-bridge");
    await expect(connectWallet("albedo")).rejects.toThrow(
      "Albedo is not installed or available.",
    );
  });

  it("rejects a bridge that exists but exposes no compatible connect API", async () => {
    windowBridge("hana", {});
    await expect(connectWallet("hana")).rejects.toThrow(
      "hana does not expose a compatible connect API.",
    );
  });
});

// ── Malformed account responses ──────────────────────────────────────────────

describe("connectWallet – malformed account responses", () => {
  const invalidKeyMessage = "Freighter did not return a valid public key.";

  const connectWithAddress = (value: AddressResult) => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue(value);
    vi.mocked(getNetworkDetails).mockResolvedValue(networkDetails(TESTNET_PASSPHRASE));
  };

  it("rejects an empty address string", async () => {
    connectWithAddress({ address: "" });

    await expect(connectWallet("freighter")).rejects.toThrow(invalidKeyMessage);
  });

  it("uses the module's own message when the provider error is unusable alongside an empty address", async () => {
    connectWithAddress({ address: "", error: "" } as unknown as AddressResult);

    await expect(connectWallet("freighter")).rejects.toThrow(invalidKeyMessage);
  });

  it("rejects a missing (undefined) address", async () => {
    connectWithAddress({ address: undefined } as unknown as AddressResult);

    await expect(connectWallet("freighter")).rejects.toThrow(invalidKeyMessage);
  });

  it("rejects a null address", async () => {
    connectWithAddress({ address: null } as unknown as AddressResult);

    await expect(connectWallet("freighter")).rejects.toThrow(invalidKeyMessage);
  });

  it("fails the connection when the provider returns an account id together with an error flag", async () => {
    // An error flag invalidates the response even when an address leaked
    // through with it — the connection must throw, never resolve.
    connectWithAddress({
      address: PUBLIC_KEY,
      error: "The user rejected the request",
    });

    await expect(connectWallet("freighter")).rejects.toThrow(
      "The user rejected the request",
    );
  });

  it("rejects a bridge response without any usable account identifier", async () => {
    windowBridge("xbull", {
      connect: vi.fn(async () => ({})),
    });

    await expect(connectWallet("xbull")).rejects.toThrow(
      "xbull did not return a public key.",
    );
  });

  it("rejects a bridge response with only empty identifier strings", async () => {
    windowBridge("xbull", {
      connect: vi.fn(async () => ({ publicKey: "", address: "" })),
    });

    await expect(connectWallet("xbull")).rejects.toThrow(
      "xbull did not return a public key.",
    );
  });

  it("fails instead of crashing on an entirely malformed bridge response", async () => {
    windowBridge("xbull", {
      connect: vi.fn(async () => null),
    });

    await expect(connectWallet("xbull")).rejects.toThrow();
  });
});

// ── Dependency failures ──────────────────────────────────────────────────────

describe("connectWallet – dependency failures", () => {
  it("propagates a failing setAllowed() without asking for the account", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockRejectedValue(new Error("not allowed yet"));
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });

    await expect(connectWallet("freighter")).rejects.toThrow("not allowed yet");
    expect(getAddress).not.toHaveBeenCalled();
  });

  it("propagates a failing provider availability check", async () => {
    vi.mocked(isConnected).mockRejectedValue(new Error("provider bridge unavailable"));

    await expect(connectWallet("freighter")).rejects.toThrow(
      "provider bridge unavailable",
    );
  });

  it("propagates a failing account lookup", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockRejectedValue(new Error("no account registered"));

    await expect(connectWallet("freighter")).rejects.toThrow("no account registered");
  });

  it("tolerates a failing network-details lookup and still connects", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });
    vi.mocked(getNetworkDetails).mockRejectedValue(new Error("network check failed"));

    const session = await connectWallet("freighter");

    expect(session.publicKey).toBe(PUBLIC_KEY);
    expect(session.network).toBe(APP_NETWORK_LABEL);
  });

  it("falls back gracefully when network details arrive with an error flag", async () => {
    vi.mocked(isConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(setAllowed).mockResolvedValue({ isAllowed: true });
    vi.mocked(getAddress).mockResolvedValue({ address: PUBLIC_KEY });
    vi.mocked(getNetworkDetails).mockResolvedValue({
      ...networkDetails(TESTNET_PASSPHRASE),
      error: { code: -1, message: "network details unavailable" },
    });

    expect((await connectWallet("freighter")).network).toBe(APP_NETWORK_LABEL);
  });
});

// ── Error message mapping (public helper) ────────────────────────────────────

describe("toWalletErrorMessage", () => {
  it("returns non-rejection wallet errors unchanged", () => {
    const message = "Network mismatch: there are no active streams in storage";
    expect(toWalletErrorMessage(new Error(message))).toBe(message);
  });

  it("maps string rejections like Error instances", () => {
    expect(toWalletErrorMessage("Request rejected by the popup")).toBe(
      userRejectionMessage,
    );
  });

  it("maps strings without rejection indications through untouched", () => {
    expect(toWalletErrorMessage("Connection timed out")).toBe("Connection timed out");
  });

  it("gives unexpected throwables a friendly default message", () => {
    expect(toWalletErrorMessage(null)).toBe("Wallet connection failed. Please try again.");
    expect(toWalletErrorMessage(undefined)).toBe(
      "Wallet connection failed. Please try again.",
    );
    expect(toWalletErrorMessage(42)).toBe("Wallet connection failed. Please try again.");
    expect(toWalletErrorMessage({ code: -1 })).toBe(
      "Wallet connection failed. Please try again.",
    );
  });
});
