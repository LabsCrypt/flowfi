import { Networks } from '@stellar/stellar-sdk';

/**
 * Runtime configuration for the Stellar Testnet E2E suite.
 * Every value can be overridden via env so the suite can also target a
 * local `stellar/quickstart` container or a futurenet deployment.
 */
export const testnetConfig = {
  rpcUrl: process.env.E2E_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  horizonUrl: process.env.E2E_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  friendbotUrl: process.env.E2E_FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
  networkPassphrase: process.env.E2E_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  /** Deployed stream contract under test (C...). Required for contract/indexer suites. */
  contractId: process.env.E2E_STREAM_CONTRACT_ID ?? '',
  /** Upper bound on average ledger close time before we flag timing drift. */
  maxLedgerCloseSeconds: Number(process.env.E2E_MAX_LEDGER_CLOSE_SECONDS ?? '15'),
  /** Max time to wait for a submitted transaction to reach a final status. */
  txTimeoutMs: Number(process.env.E2E_TX_TIMEOUT_MS ?? '90000'),
  /** Max time to wait for the indexer to ingest on-chain events into Postgres. */
  indexerTimeoutMs: Number(process.env.E2E_INDEXER_TIMEOUT_MS ?? '120000'),
};

export function hasContract(): boolean {
  return testnetConfig.contractId.length > 0;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
