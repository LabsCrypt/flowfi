import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the live Stellar Testnet E2E suite.
 *
 * Kept separate from the default config so `npm test` never touches the
 * network. Run with `npm run test:e2e:testnet` (see e2e/testnet/README.md).
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    root: new URL('../..', import.meta.url).pathname,
    include: ['e2e/testnet/**/*.e2e.test.ts'],
    env: {
      JWT_SECRET: 'flowfi-testnet-e2e-secret-do-not-use-in-production',
    },
    // Live network: ledger close is ~5s and Friendbot/RPC can be slow.
    testTimeout: 180_000,
    hookTimeout: 240_000,
    // Tests within a file share on-chain state (accounts, stream IDs) and
    // must run in order; files run sequentially to avoid Friendbot rate limits.
    sequence: { concurrent: false },
    fileParallelism: false,
    pool: 'forks',
    coverage: { enabled: false },
    reporters: ['default', 'junit'],
    outputFile: { junit: './e2e-results/testnet-junit.xml' },
  },
});
