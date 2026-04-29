/**
 * Convert raw on-chain amount (stroops/smallest unit) to human-readable string
 */
export function fromStroops(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();

  const factor = 10n ** BigInt(decimals);
  const integerPart = amount / factor;
  const fractionalPart = amount % factor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  const trimmedFractional = fractionalStr.replace(/0+$/, "");

  if (!trimmedFractional) return integerPart.toString();
  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Convert human-readable amount to raw on-chain amount (stroops/smallest unit)
 */
export function toStroops(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) return 0n;

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
 * Format stream rate as human-readable string (e.g., "0.0001 USDC/sec")
 */
export function formatStreamRate(
  ratePerSecond: bigint,
  decimals: number,
  tokenSymbol: string = "USDC"
): string {
  const perSecond = fromStroops(ratePerSecond, decimals);
  const perMonth = fromStroops(ratePerSecond * 60n * 60n * 24n * 30n, decimals);

  return `${perSecond} ${tokenSymbol}/sec (${perMonth} ${tokenSymbol}/month)`;
}

/**
 * Validate that amount string doesn't exceed decimal precision
 */
export function hasValidPrecision(amount: string, decimals: number): boolean {
  if (!amount) return true;

  const parts = amount.split(".");
  if (parts.length === 0 || parts.length > 2) return false;

  const fractionalPart = parts[1];
  if (fractionalPart && fractionalPart.length > decimals) return false;

  return true;
}

/**
 * Cache for token decimals to avoid repeated contract calls
 */
const tokenDecimalsCache = new Map<string, number>();

/**
 * Get and cache token decimals for a given token address
 */
export function getCachedTokenDecimals(tokenAddress: string): number | undefined {
  return tokenDecimalsCache.get(tokenAddress);
}

/**
 * Set token decimals in cache
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
