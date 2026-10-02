/**
 * Mock Mode Configuration
 *
 * Mock mode backs the one-click local sandbox (`npm run dev:mock`, issue
 * #1336). When enabled, Soroban-dependent operations are answered locally —
 * no testnet RPC, no deployed contract, no funded wallet — so a contributor can
 * exercise the whole UI on a fresh clone.
 *
 * It is hard-disabled in production: `NODE_ENV=production` always wins, so a
 * misconfigured deployment cannot expose the unauthenticated mock auth route.
 */

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Strict boolean parse. Anything other than 'true'/'false' is treated as
 * 'false' rather than throwing, so a typo in a contributor's shell environment
 * can never crash the API on boot (unlike the sandbox config, which is
 * validated strictly because it guards data isolation).
 */
function isEnabled(value: string | undefined): boolean {
  return value === 'true';
}

/** True when the backend should answer Soroban operations locally. */
export function isMockMode(): boolean {
  return !isProduction && isEnabled(process.env.MOCK_MODE);
}

/** Mock sessions get a longer TTL than real wallet logins; they are throwaway. */
export const MOCK_TOKEN_EXPIRY_SECONDS = 24 * 60 * 60;