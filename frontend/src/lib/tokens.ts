import { TOKEN_ADDRESSES } from "@/lib/soroban";

/**
 * Single source of truth for token contract address → symbol resolution.
 *
 * Everything is derived from `TOKEN_ADDRESSES` in `lib/soroban.ts`, so adding a
 * new token there (or overriding an address via `NEXT_PUBLIC_*_ADDRESS`) is
 * picked up by every surface that renders a token symbol.
 */

/** Returns the symbol (e.g. "XLM", "USDC") for a known token address, else `undefined`. */
export function resolveTokenSymbol(
  tokenAddress: string | null | undefined,
): string | undefined {
  if (!tokenAddress) return undefined;
  const entry = Object.entries(TOKEN_ADDRESSES).find(
    ([, address]) => address === tokenAddress,
  );
  return entry?.[0];
}

function shortenTokenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Resolves a token address to its symbol, falling back to a shortened address
 * (e.g. "CABCDE...WXYZ") when the token is unknown.
 */
export function resolveTokenLabel(tokenAddress: string): string {
  return resolveTokenSymbol(tokenAddress) ?? shortenTokenAddress(tokenAddress);
}
