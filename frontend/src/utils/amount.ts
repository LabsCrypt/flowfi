/**
 * Convert raw on-chain amount (smallest unit) to human-readable string
 * @param raw - Raw amount as bigint (i128 from chain)
 * @param decimals - Number of decimal places for the token
 * @returns Formatted string e.g., "10.5000000"
 */
export function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  if (decimals === 0) return raw.toString();

  const factor = 10n ** BigInt(decimals);
  const integerPart = raw / factor;
  const fractionalPart = raw % factor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  const trimmedFractional = fractionalStr.replace(/0+$/, "");

  if (!trimmedFractional) return integerPart.toString();
  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Alias for formatAmount - convert raw on-chain amount to human-readable string
 * @deprecated Use formatAmount instead
 */
export function fromStroops(amount: bigint, decimals: number): string {
  return formatAmount(amount, decimals);
}

/**
 * Convert human-readable amount to raw on-chain amount (smallest unit)
 * @param display - Display string (e.g., "1.234")
 * @param decimals - Number of decimal places for the token
 * @returns Raw amount as bigint
 */
export function parseAmount(display: string, decimals: number): bigint {
  const trimmed = display.trim();
  if (!trimmed) return 0n;

  // Validate input is a valid number format
  if (!/^\d*\.?\d*$/.test(trimmed)) return 0n;

  const parts = trimmed.split(".");
  const integerPart = parts[0] || "0";
  let fractionalPart = parts[1] || "";

  if (fractionalPart.length > decimals) {
    fractionalPart = fractionalPart.slice(0, decimals);
  } else if (fractionalPart.length < decimals) {
    fractionalPart = fractionalPart.padEnd(decimals, "0");
  }

  const factor = 10n ** BigInt(decimals);
  return BigInt(integerPart) * factor + BigInt(fractionalPart);
}

/**
 * Alias for parseAmount - convert human-readable to raw on-chain amount
 * @deprecated Use parseAmount instead
 */
export function toStroops(amount: string, decimals: number): bigint {
  return parseAmount(amount, decimals);
}

/**
 * Format rate per second to human-readable string showing both per-second and per-day
 * @param ratePerSec - Rate per second as bigint
 * @param decimals - Number of decimal places for the token
 * @param symbol - Token symbol (optional)
 * @returns Formatted rate string e.g., "0.0001 USDC/sec (8.64 USDC/day)"
 */
export function formatRate(
  ratePerSec: bigint,
  decimals: number,
  symbol = ""
): string {
  if (ratePerSec === 0n) return symbol ? `0 ${symbol}/sec` : "0/sec";

  const perSecond = formatAmount(ratePerSec, decimals);
  const perDay = formatAmount(ratePerSec * 86400n, decimals); // 86400 seconds in a day

  const symbolStr = symbol ? ` ${symbol}` : "";
  return `${perSecond}${symbolStr}/sec (${perDay}${symbolStr}/day)`;
}

/**
 * Format stream rate as human-readable string
 * @deprecated Use formatRate instead
 */
export function formatStreamRate(
  ratePerSecond: bigint,
  decimals: number,
  tokenSymbol: string = "USDC"
): string {
  return formatRate(ratePerSecond, decimals, tokenSymbol);
}

/**
 * Check if input string has valid precision for the given decimals
 * @param input - Input string to validate
 * @param decimals - Maximum allowed decimal places
 * @returns True if valid precision
 */
export function hasValidPrecision(input: string, decimals: number): boolean {
  if (!input || input.trim() === "") return true; // Empty is valid (will be parsed as 0)

  const cleanInput = input.trim();

  // Check if it's a valid number format (digits with optional single decimal point)
  if (!/^\d*\.?\d*$/.test(cleanInput)) return false;

  // Check for negative sign (not allowed for amounts)
  if (cleanInput.startsWith("-")) return false;

  if (cleanInput.includes(".")) {
    const fractionalPart = cleanInput.split(".")[1];
    return fractionalPart ? fractionalPart.length <= decimals : true;
  }

  return true;
}

/**
 * Validate amount input and return error message if invalid
 * @param input - Input string to validate
 * @param decimals - Maximum allowed decimal places
 * @returns Error message or null if valid
 */
export function validateAmountInput(
  input: string,
  decimals: number
): string | null {
  if (!input || input.trim() === "") {
    return "Amount is required";
  }

  const cleanInput = input.trim();

  // Check for valid number format
  if (!/^\d*\.?\d*$/.test(cleanInput)) {
    return "Please enter a valid number";
  }

  // Check precision
  if (!hasValidPrecision(cleanInput, decimals)) {
    return `Amount cannot have more than ${decimals} decimal places`;
  }

  // Check for positive value
  const numericValue = parseFloat(cleanInput);
  if (isNaN(numericValue) || numericValue <= 0) {
    return "Amount must be greater than 0";
  }

  return null;
}

/**
 * Cache for token decimals to avoid repeated contract calls
 */
const tokenDecimalsCache = new Map<string, number>();

// Default decimals for known tokens (Stellar uses 7 for XLM, 6 or 7 for most tokens)
const DEFAULT_TOKEN_DECIMALS: Record<string, number> = {
  XLM: 7,
  USDC: 7,
  EURC: 7,
  FLOW: 7,
};

/**
 * Get cached token decimals for a given token address
 * @param tokenAddress - Token contract address
 * @returns Cached decimals or undefined if not cached
 */
export function getCachedTokenDecimals(tokenAddress: string): number | undefined {
  return tokenDecimalsCache.get(tokenAddress);
}

/**
 * Set token decimals in cache
 * @param tokenAddress - Token contract address
 * @param decimals - Token decimal places
 */
export function setCachedTokenDecimals(
  tokenAddress: string,
  decimals: number
): void {
  tokenDecimalsCache.set(tokenAddress, decimals);
}

/**
 * Clear token decimals cache
 */
export function clearTokenDecimalsCache(): void {
  tokenDecimalsCache.clear();
}

/**
 * Get default decimals for known token symbols
 * @param symbol - Token symbol (e.g., "USDC", "XLM")
 * @returns Default decimals or 7 if unknown
 */
export function getDefaultTokenDecimals(symbol: string): number {
  return DEFAULT_TOKEN_DECIMALS[symbol.toUpperCase()] ?? 7;
}

// RPC configuration for fetching token decimals
const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

/**
 * Fetch token decimals from the Soroban contract
 * Fetches once and caches per token address
 * @param tokenAddress - Token contract address
 * @returns Promise resolving to token decimals
 */
export async function fetchTokenDecimals(tokenAddress: string): Promise<number> {
  // Check cache first
  const cached = getCachedTokenDecimals(tokenAddress);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk: any = await import("@stellar/stellar-sdk");
    const { Contract, TransactionBuilder, BASE_FEE } = sdk;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc: any = sdk.rpc ?? sdk.SorobanRpc;

    // Use a dummy account for simulation (just need to read contract data)
    const dummyKeypair = sdk.Keypair.random();
    const server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });

    // Build a transaction to call the 'decimals' function
    const account = await server.getAccount(dummyKeypair.publicKey());
    const tokenContract = new Contract(tokenAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(tokenContract.call("decimals"))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);

    if (rpc.Api?.isSimulationError?.(simResult) ?? simResult?.error) {
      console.warn(`Failed to fetch decimals for ${tokenAddress}:`, simResult.error);
      // Cache default to avoid repeated failed calls
      setCachedTokenDecimals(tokenAddress, 7);
      return 7;
    }

    const rawResult = simResult?.result?.retval;
    if (!rawResult) {
      console.warn(`No decimals returned for ${tokenAddress}`);
      setCachedTokenDecimals(tokenAddress, 7);
      return 7;
    }

    const nativeValue = sdk.scValToNative(rawResult);
    let decimals: number;

    if (typeof nativeValue === "number") {
      decimals = nativeValue;
    } else if (typeof nativeValue === "bigint") {
      decimals = Number(nativeValue);
    } else if (typeof nativeValue === "string") {
      decimals = parseInt(nativeValue, 10);
    } else {
      decimals = 7;
    }

    // Cache the result
    setCachedTokenDecimals(tokenAddress, decimals);
    return decimals;
  } catch (error) {
    console.error(`Error fetching token decimals for ${tokenAddress}:`, error);
    // Cache default to avoid repeated failed calls
    setCachedTokenDecimals(tokenAddress, 7);
    return 7;
  }
}

/**
 * React hook compatible function to get token decimals
 * Returns cached value immediately if available, otherwise fetches and caches
 * @param tokenAddress - Token contract address
 * @param callback - Optional callback when decimals are fetched
 * @returns Current decimals (cached or default 7)
 */
export function getTokenDecimalsSync(
  tokenAddress: string,
  callback?: (decimals: number) => void
): number {
  const cached = getCachedTokenDecimals(tokenAddress);
  if (cached !== undefined) {
    return cached;
  }

  // Trigger async fetch if not cached
  if (callback) {
    fetchTokenDecimals(tokenAddress).then(callback).catch(() => callback(7));
  }

  return 7; // Return default while fetching
}
