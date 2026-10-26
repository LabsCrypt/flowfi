import { StrKey } from "@stellar/stellar-sdk/base";
import type { NetworkId } from "./stellar-config";

/**
 * Validate a Stellar Ed25519 public key (\"G...\") using the full StrKey
 * checksum, rather than only prefix/length heuristics.
 *
 * `StrKey.isValidEd25519PublicKey` verifies the CRC16-XModem checksum and
 * rejects malformed keys as well as muxed (M...), contract (C...), secret (S...)
 * and other StrKey types that the stream contract does not accept. Surrounding whitespace is trimmed before validation.
 */
export function isValidStellarPublicKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return StrKey.isValidEd25519PublicKey(normalized);
}

/**
 * Normalize a network identifier to lowercase for matching.
 */
function normalizeNetwork(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Validate a Stellar network passphrase or identifier.
 *
 * Accepts:
 * - NetworkId type values: "testnet", "futurenet", "mainnet", "sandbox"
 * - Full passphrase strings (e.g. "Test SDF Network ; September 2015")
 * - Short IDs (e.g. "testnet", "mainnet")
 *
 * Returns the normalized NetworkId if valid, or an error message string.
 */
export function validateNetworkId(value: string): { valid: true; id: NetworkId } | { valid: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, error: "Network identifier is required" };
  }

  const normalized = normalizeNetwork(trimmed);

  // Map of known passphrases (lowercase key -> NetworkId)
  const knownPassphrases: Record<string, NetworkId> = {
    "test sdf network ; september 2015": "testnet",
    "public global stellar network ; september 2015": "mainnet",
    "test sdf future network ; october 2022": "futurenet",
    "standalone network ; february 2017": "sandbox",
  };

  // Check against known passphrases (case-insensitive via normalized key)
  if (knownPassphrases[normalized]) {
    return { valid: true, id: knownPassphrases[normalized] };
  }

  // Check against short IDs
  if (
    normalized === "testnet" ||
    normalized === "mainnet" ||
    normalized === "futurenet" ||
    normalized === "sandbox"
  ) {
    return { valid: true, id: normalized as NetworkId };
  }

  return { valid: false, error: `Unsupported network: "${trimmed}". Supported networks: testnet, futurenet, mainnet, sandbox` };
}

/**
 * Check if a network is supported for Stellar operations.
 *
 * @param value - Network identifier to check (passphrase, short ID, or NetworkId)
 * @returns true if the network is supported, false otherwise
 */
export function isNetworkSupported(value: string): boolean {
  return validateNetworkId(value).valid;
}

/**
 * Get the Horizon URL for a given network identifier.
 *
 * @param value - Network identifier (passphrase, short ID, or NetworkId)
 * @returns The Horizon URL if the network is supported, otherwise the sandbox URL as fallback
 */
export function getHorizonUrl(value: string): string {
  const result = validateNetworkId(value);
  if (!result.valid) {
    return "http://localhost:8000"; // sandbox fallback
  }

  const networkConfigs: Record<NetworkId, { horizonUrl: string }> = {
    testnet: { horizonUrl: "https://horizon-testnet.stellar.org" },
    futurenet: { horizonUrl: "https://horizon-futurenet.stellar.org" },
    mainnet: { horizonUrl: "https://horizon.stellar.org" },
    sandbox: { horizonUrl: "http://localhost:8000" },
  };

  return networkConfigs[result.id].horizonUrl;
}

/**
 * Get the network passphrase for a given network identifier.
 *
 * @param value - Network identifier (passphrase, short ID, or NetworkId)
 * @returns The network passphrase if supported, otherwise the testnet passphrase as fallback
 */
export function getNetworkPassphrase(value: string): string {
  const result = validateNetworkId(value);
  if (!result.valid) {
    return "Test SDF Network ; September 2015"; // testnet fallback
  }

  const networkPassphrases: Record<NetworkId, string> = {
    testnet: "Test SDF Network ; September 2015",
    futurenet: "Test SDF Future Network ; October 2022",
    mainnet: "Public Global Stellar Network ; September 2015",
    sandbox: "Standalone Network ; February 2017",
  };

  return networkPassphrases[result.id];
}
