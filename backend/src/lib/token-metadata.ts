/**
 * Verified Stellar asset metadata.
 *
 * Token metadata (symbol, name, decimals, icon) changes very rarely, which is
 * exactly why `/v1/tokens` can be served with an aggressive `Cache-Control` and
 * an `ETag`: once a dashboard has the list it can revalidate with a single
 * cheap conditional request instead of refetching on every route transition.
 *
 * The store is deliberately small and in-memory — there are only a handful of
 * verified assets per network. `updatedAt` bumps on any mutation so the route's
 * ETag changes and previously cached responses are revalidated (and therefore
 * invalidated) cleanly.
 */

export interface TokenMetadata {
  /** Ticker used across the API and UI, e.g. `USDC`. */
  symbol: string;
  /** Human-readable asset name. */
  name: string;
  /** Number of decimal places the contract uses (Stellar assets use 7). */
  decimals: number;
  /** `native` for XLM, otherwise the Soroban contract address (C…). */
  contractAddress: string;
  /** Display/rounding type. */
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  /** Optional icon URL for the dashboard. */
  icon?: string;
  /** Short description shown in token pickers. */
  description?: string;
  /** True for assets curated by FlowFi. */
  verified: boolean;
}

export interface TokenMetadataList {
  tokens: TokenMetadata[];
  /** ISO timestamp of the last mutation; part of the ETag payload. */
  updatedAt: string;
}

/** Default verified assets. Contract addresses are env-overridable per network. */
function defaultTokens(): TokenMetadata[] {
  return [
    {
      symbol: 'XLM',
      name: 'Stellar Lumens',
      decimals: 7,
      contractAddress:
        process.env.XLM_TOKEN_ADDRESS ??
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN',
      type: 'native',
      icon: 'https://assets.flowfi.xyz/tokens/xlm.svg',
      description: 'Native Stellar token',
      verified: true,
    },
    {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress:
        process.env.USDC_TOKEN_ADDRESS ??
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      type: 'credit_alphanum4',
      icon: 'https://assets.flowfi.xyz/tokens/usdc.svg',
      description: 'USD Coin',
      verified: true,
    },
    {
      symbol: 'EURC',
      name: 'Euro Coin',
      decimals: 7,
      contractAddress:
        process.env.EURC_TOKEN_ADDRESS ??
        'CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY',
      type: 'credit_alphanum4',
      icon: 'https://assets.flowfi.xyz/tokens/eurc.svg',
      description: 'Euro Coin',
      verified: true,
    },
  ];
}

const verifiedTokens = new Map<string, TokenMetadata>();
let updatedAt = new Date().toISOString();

function loadDefaults(): void {
  verifiedTokens.clear();
  for (const token of defaultTokens()) {
    verifiedTokens.set(token.symbol.toUpperCase(), token);
  }
}

function touch(): void {
  updatedAt = new Date().toISOString();
}

loadDefaults();

/** All verified tokens, stably ordered by symbol. */
export function listVerifiedTokens(): TokenMetadata[] {
  return [...verifiedTokens.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Version marker used in the payload (and therefore the ETag). */
export function getTokenMetadataUpdatedAt(): string {
  return updatedAt;
}

export function getTokenMetadata(symbol: string): TokenMetadata | undefined {
  return verifiedTokens.get(symbol.toUpperCase());
}

/**
 * Insert or update a token's metadata. Bumping the version changes the ETag so
 * clients holding a cached copy revalidate on their next request.
 */
export function upsertTokenMetadata(token: TokenMetadata): TokenMetadata {
  const entry: TokenMetadata = { ...token, symbol: token.symbol.toUpperCase() };
  verifiedTokens.set(entry.symbol, entry);
  touch();
  return entry;
}

/** Remove a token. Also bumps the version so caches are invalidated. */
export function removeTokenMetadata(symbol: string): boolean {
  const removed = verifiedTokens.delete(symbol.toUpperCase());
  if (removed) touch();
  return removed;
}

/** Restore the default seed set. Intended for tests. */
export function resetTokenMetadata(): void {
  loadDefaults();
  touch();
}
