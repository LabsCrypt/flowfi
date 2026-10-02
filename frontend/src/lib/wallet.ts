/**
 * lib/wallet.ts
 *
 * Production wallet adapter for FlowFi.
 * Currently supports Freighter (browser extension).
 *
 * Albedo and xBull are intentionally not advertised until real connectors are
 * implemented. No mock sessions are created in production paths.
 * Set NEXT_PUBLIC_STELLAR_NETWORK=TESTNET|MAINNET in .env to control network.
 */

// ── Network configuration ─────────────────────────────────────────────────────

export const STELLAR_NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ??
  "TESTNET") as "TESTNET" | "MAINNET";

export const STELLAR_NETWORK_ID =
  STELLAR_NETWORK === "MAINNET"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

import {
  isConnected,
  setAllowed,
  getAddress,
  getNetworkDetails,
} from "@stellar/freighter-api";

export type WalletId = "freighter" | "albedo" | "xbull" | "hana" | "walletconnect" | "mock";

/** Wallet id used by sandbox sessions (see lib/mock-chain.ts). */
export const MOCK_WALLET_ID = "mock" satisfies WalletId;
export const MOCK_WALLET_NAME = "Sandbox Account";

export interface WalletDescriptor {
  id: WalletId;
  name: string;
  badge: string;
  description: string;
}

export interface WalletSession {
  walletId: WalletId;
  walletName: string;
  publicKey: string;
  connectedAt: string;
  network: string;
  mocked: boolean;
}

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown when the user tries to connect Freighter but the extension is not
 * installed. The UI checks for this to show an install prompt instead of a
 * generic error message.
 */
export class FreighterNotInstalledError extends Error {
  constructor() {
    super(
      "Freighter extension is not installed. Please install it from freighter.app.",
    );
    this.name = "FreighterNotInstalledError";
  }
}

// ── Wallet metadata ───────────────────────────────────────────────────────────

export const SUPPORTED_WALLETS: readonly WalletDescriptor[] = [
  { id: "freighter", name: "Freighter", badge: "Extension", description: "Direct browser wallet for Stellar accounts and Soroban apps." },
  { id: "albedo", name: "Albedo", badge: "Web / Mobile", description: "Popup wallet for browser and mobile users." },
  { id: "xbull", name: "xBull", badge: "Extension / Web", description: "Stellar wallet for desktop and web users." },
  { id: "hana", name: "Hana", badge: "Extension", description: "Secure Stellar browser wallet." },
  { id: "walletconnect", name: "WalletConnect", badge: "Mobile", description: "Connect mobile wallets with WalletConnect." },
];

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildSession(
  walletId: WalletId,
  publicKey: string,
  network: string,
  mocked = false,
): WalletSession {
  // The mock wallet has no descriptor in SUPPORTED_WALLETS — it is only ever
  // reachable from the sandbox account picker.
  const descriptor = SUPPORTED_WALLETS.find((w) => w.id === walletId);

  if (!descriptor && !mocked) {
    throw new Error("Unsupported wallet selected.");
  }

  return {
    walletId,
    walletName: descriptor?.name ?? MOCK_WALLET_NAME,
    publicKey,
    connectedAt: new Date().toISOString(),
    network,
    mocked,
  };
}

/**
 * Build a sandbox session for one of the seeded mock accounts.
 *
 * Only called when NEXT_PUBLIC_MOCK_MODE=true; the backend refuses to issue the
 * matching token unless it is running in mock mode outside production.
 */
export async function connectMockWallet(publicKey: string): Promise<WalletSession> {
  const { MOCK_MODE, fetchMockToken } = await import("@/lib/mock-chain");
  if (!MOCK_MODE) {
    throw new Error("Mock wallets are disabled. Set NEXT_PUBLIC_MOCK_MODE=true to enable the sandbox.");
  }

  // Prove the account exists and is servable by the sandbox backend before
  // handing the UI a session it would otherwise fail every request with.
  await fetchMockToken(publicKey);

  return buildSession(
    MOCK_WALLET_ID,
    publicKey,
    STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet",
    true,
  );
}

// ── Freighter ─────────────────────────────────────────────────────────────────

async function connectFreighter(): Promise<WalletSession> {
  const connObj = await isConnected();
  if (!connObj.isConnected) {
    throw new FreighterNotInstalledError();
  }

  await setAllowed();

  const { address, error: addressError } = await getAddress();

  if (!address || addressError) {
    throw new Error(
      addressError || "Freighter did not return a valid public key.",
    );
  }

  let networkId = STELLAR_NETWORK_ID.toLowerCase().includes("public")
    ? "Mainnet"
    : "Testnet";

  try {
    const details = await getNetworkDetails();
    if (details.networkPassphrase && !details.error) {
      const raw = String(details.networkPassphrase).toLowerCase();
      if (raw.includes("public") || raw === "mainnet") {
        networkId = "Mainnet";
      } else if (raw.includes("test") || raw.includes("sdf")) {
        networkId = "Testnet";
      } else {
        networkId = "Other";
      }
    }
  } catch {
    // ignore
  }

  return buildSession("freighter", address, networkId);
}

// ── Public connect dispatch ───────────────────────────────────────────────────

export async function connectWallet(
  walletId: WalletId,
): Promise<WalletSession> {
  if (walletId === "freighter") return connectFreighter();

  // These adapters are exposed through their wallet web bridges when installed.
  // Fail clearly rather than creating an unverifiable/mock session.
  const bridge = (window as unknown as Record<string, unknown>)[walletId];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(`${SUPPORTED_WALLETS.find((wallet) => wallet.id === walletId)?.name ?? walletId} is not installed or available.`);
  }
  const api = bridge as { connect?: () => Promise<{ publicKey?: string; address?: string }> };
  if (!api.connect) throw new Error(`${walletId} does not expose a compatible connect API.`);
  const result = await api.connect();
  const publicKey = result.publicKey ?? result.address;
  if (!publicKey) throw new Error(`${walletId} did not return a public key.`);
  return buildSession(walletId, publicKey, STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet");
}

// ── Error message mapping ─────────────────────────────────────────────────────

const USER_REJECTION_PATTERNS = [
  /rejected/i,
  /declined/i,
  /denied/i,
  /canceled/i,
  /cancelled/i,
  /closed/i,
  /user.*denied/i,
  /user.*abort/i,
  /popup.*closed/i,
  /window.*closed/i,
];

export function toWalletErrorMessage(error: unknown): string {
  // Provide a specialised message for the extension-not-installed case.
  if (error instanceof FreighterNotInstalledError) {
    return error.message;
  }

  const baseMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Wallet connection failed. Please try again.";

  if (USER_REJECTION_PATTERNS.some((pattern) => pattern.test(baseMessage))) {
    return "You rejected the connection request. Try again when ready.";
  }

  return baseMessage;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function shortenPublicKey(publicKey: string): string {
  if (publicKey.length <= 14) {
    return publicKey;
  }

  return `${publicKey.slice(0, 7)}...${publicKey.slice(-7)}`;
}

/**
 * Maps raw Stellar network strings (passphrases, env-style IDs, legacy labels)
 * to friendly display labels: "Mainnet" | "Testnet" | original string.
 */
export function formatNetwork(network: string): string {
  const n = network.trim().toLowerCase();

  if (n.includes("public") || n === "mainnet" || n === "public") {
    return "Mainnet";
  }

  if (
    n.includes("test") ||
    n === "testnet" ||
    n.includes("sdf") ||
    n === "stellar testnet"
  ) {
    return "Testnet";
  }

  return network;
}

/**
 * Returns true if the connected wallet's network matches what this app is
 * configured to use (NEXT_PUBLIC_STELLAR_NETWORK).
 */
export function isExpectedNetwork(sessionNetwork: string): boolean {
  const sessionLabel = formatNetwork(sessionNetwork);
  const expectedLabel = STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet";
  return sessionLabel === expectedLabel;
}
