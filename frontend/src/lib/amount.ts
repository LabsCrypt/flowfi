/**
 * Shared utilities for formatting and parsing token amounts
 * Handles conversion between raw on-chain amounts (i128) and display values
 */

/**
 * Format raw amount (bigint) to display string with proper decimal places
 * @param raw - Raw amount as bigint
 * @param decimals - Number of decimal places for the token
 * @returns Formatted string
 */
export function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fractional = raw % divisor;
  
  if (fractional === 0n) {
    return whole.toString();
  }
  
  // Pad fractional part with leading zeros
  const fractionalStr = fractional.toString().padStart(decimals, '0');
  
  // Remove trailing zeros
  const trimmedFractional = fractionalStr.replace(/0+$/, '');
  
  return `${whole}.${trimmedFractional}`;
}

/**
 * Parse display string back to raw amount (bigint)
 * @param display - Display string (e.g., "1.234")
 * @param decimals - Number of decimal places for the token
 * @returns Raw amount as bigint
 */
export function parseAmount(display: string, decimals: number): bigint {
  if (!display || display.trim() === '') return 0n;
  
  const cleanDisplay = display.trim();
  const divisor = 10n ** BigInt(decimals);
  
  if (cleanDisplay.includes('.')) {
    const [wholePart, fractionalPart] = cleanDisplay.split('.');
    const whole = BigInt(wholePart || '0');
    
    // Handle fractional part - pad or truncate to correct length
    let fractional = fractionalPart || '';
    if (fractional.length > decimals) {
      // Truncate if too long
      fractional = fractional.slice(0, decimals);
    } else {
      // Pad with zeros if too short
      fractional = fractional.padEnd(decimals, '0');
    }
    
    const fractionalBig = BigInt(fractional || '0');
    return whole * divisor + fractionalBig;
  } else {
    return BigInt(cleanDisplay) * divisor;
  }
}

/**
 * Format rate per second to human-readable string
 * @param ratePerSec - Rate per second as bigint
 * @param decimals - Number of decimal places for the token
 * @param symbol - Token symbol (optional)
 * @returns Formatted rate string
 */
export function formatRate(ratePerSec: bigint, decimals: number, symbol = ''): string {
  if (ratePerSec === 0n) return '0';
  
  const ratePerSecond = formatAmount(ratePerSec, decimals);
  const ratePerDay = formatAmount(ratePerSec * 86400n, decimals); // 86400 seconds in a day
  
  const symbolStr = symbol ? ` ${symbol}` : '';
  return `${ratePerSecond}${symbolStr}/sec (${ratePerDay}${symbolStr}/day)`;
}

/**
 * Check if input string has valid precision for the given decimals
 * @param input - Input string to validate
 * @param decimals - Maximum allowed decimal places
 * @returns True if valid precision
 */
export function hasValidPrecision(input: string, decimals: number): boolean {
  if (!input || input.trim() === '') return true; // Empty is valid (will be parsed as 0)
  
  const cleanInput = input.trim();
  
  // Check if it's a valid number format
  if (!/^\d*\.?\d*$/.test(cleanInput)) return false;
  
  if (cleanInput.includes('.')) {
    const fractionalPart = cleanInput.split('.')[1];
    return fractionalPart.length <= decimals;
  }
  
  return true;
}

/**
 * Convert value to stroops (smallest unit, 7 decimal places for XLM)
 * @param value - String value in XLM
 * @returns Value in stroops as bigint
 */
export function toStroops(value: string): bigint {
  return parseAmount(value, 7); // XLM uses 7 decimal places
}

/**
 * Convert stroops back to XLM string
 * @param stroops - Value in stroops as bigint
 * @returns XLM string
 */
export function fromStroops(stroops: bigint): string {
  return formatAmount(stroops, 7);
}

/**
 * Truncate amount to specified decimal places without rounding
 * @param amount - Amount as bigint
 * @param decimals - Token decimals
 * @param maxDisplayDecimals - Maximum decimal places to display
 * @returns Truncated string
 */
export function truncateAmount(amount: bigint, decimals: number, maxDisplayDecimals: number): string {
  if (amount === 0n) return '0';
  
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fractional = amount % divisor;
  
  if (fractional === 0n) {
    return whole.toString();
  }
  
  // Convert fractional to string and truncate
  const fractionalStr = fractional.toString().padStart(decimals, '0');
  const truncatedFractional = fractionalStr.slice(0, maxDisplayDecimals);
  
  // Remove trailing zeros from truncated part
  const trimmedFractional = truncatedFractional.replace(/0+$/, '');
  
  if (trimmedFractional === '') {
    return whole.toString();
  }
  
  return `${whole}.${trimmedFractional}`;
}

/**
 * Format amount with compact notation (K, M, B) for large numbers
 * @param amount - Amount as bigint
 * @param decimals - Token decimals
 * @returns Compact formatted string
 */
export function formatCompactAmount(amount: bigint, decimals: number): string {
  const displayAmount = formatAmount(amount, decimals);
  const num = parseFloat(displayAmount);
  
  if (num === 0) return '0';
  if (num < 1000) return displayAmount;
  if (num < 1000000) return `${(num / 1000).toFixed(1)}K`;
  if (num < 1000000000) return `${(num / 1000000).toFixed(1)}M`;
  return `${(num / 1000000000).toFixed(1)}B`;
}
