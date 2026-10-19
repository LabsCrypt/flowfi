/**
 * Live Stellar Testnet protocol-health checks.
 *
 * Catches drift that mocked RPC tests cannot: RPC availability, network
 * passphrase / protocol version changes, ledger close timing, fee surges,
 * and Friendbot funding regressions.
 */
import { describe, it, expect } from 'vitest';
import { Horizon } from '@stellar/stellar-sdk';
import { testnetConfig } from './helpers/config.js';
import { createFundedAccount, server, sleep, withRetry } from './helpers/soroban.js';

describe('Stellar Testnet: RPC & network health', () => {
  it('RPC reports healthy', async () => {
    const health = await withRetry('getHealth', () => server.getHealth());
    expect(health.status).toBe('healthy');
  });

  it('network passphrase matches and protocol version is supported', async () => {
    const network = await withRetry('getNetwork', () => server.getNetwork());
    expect(network.passphrase).toBe(testnetConfig.networkPassphrase);
    // Soroban requires protocol >= 20. Log the version so upgrades are
    // visible in the scheduled-run history even when nothing breaks.
    console.info(`[testnet-e2e] protocolVersion=${network.protocolVersion}`);
    expect(network.protocolVersion).toBeGreaterThanOrEqual(20);
  });

  it('ledgers advance within the expected close-time budget', async () => {
    const first = await withRetry('getLatestLedger', () => server.getLatestLedger());
    const startedAt = Date.now();
    const targetAdvance = 3;

    let latest = first;
    while (latest.sequence < first.sequence + targetAdvance) {
      if (Date.now() - startedAt > testnetConfig.maxLedgerCloseSeconds * targetAdvance * 1_000) {
        throw new Error(
          `Ledger stalled: advanced ${latest.sequence - first.sequence}/${targetAdvance} ledgers in ${
            (Date.now() - startedAt) / 1_000
          }s (from ${first.sequence})`,
        );
      }
      await sleep(1_000);
      latest = await withRetry('getLatestLedger', () => server.getLatestLedger());
    }

    const avgClose = (Date.now() - startedAt) / 1_000 / (latest.sequence - first.sequence);
    console.info(`[testnet-e2e] avgLedgerClose=${avgClose.toFixed(2)}s`);
    expect(avgClose).toBeLessThanOrEqual(testnetConfig.maxLedgerCloseSeconds);
  });

  it('RPC and Horizon agree on the latest ledger (within tolerance)', async () => {
    const horizon = new Horizon.Server(testnetConfig.horizonUrl);
    const [rpcLedger, horizonLedgers] = await Promise.all([
      withRetry('getLatestLedger', () => server.getLatestLedger()),
      withRetry('horizon ledgers', () => horizon.ledgers().order('desc').limit(1).call()),
    ]);
    const horizonSeq = horizonLedgers.records[0]?.sequence ?? 0;
    // Allow a few ledgers of ingestion skew between the two services.
    expect(Math.abs(rpcLedger.sequence - horizonSeq)).toBeLessThanOrEqual(10);
  });

  it('fee stats are available and not in an extreme surge', async () => {
    const stats = await withRetry('getFeeStats', () => server.getFeeStats());
    const p90 = Number(stats.sorobanInclusionFee.p90);
    console.info(
      `[testnet-e2e] sorobanInclusionFee p50=${stats.sorobanInclusionFee.p50} p90=${p90} maxFee=${stats.sorobanInclusionFee.max}`,
    );
    expect(Number.isFinite(p90)).toBe(true);
    // BASE_FEE-priced transactions (what the app submits) stop landing if
    // inclusion fees surge by orders of magnitude; flag that early.
    const surgeCeiling = Number(process.env.E2E_MAX_P90_INCLUSION_FEE ?? '100000');
    expect(p90).toBeLessThanOrEqual(surgeCeiling);
  });

  it('Friendbot funds a fresh account that is visible on RPC', async () => {
    const kp = await createFundedAccount();
    const account = await server.getAccount(kp.publicKey());
    expect(account.accountId()).toBe(kp.publicKey());

    const horizon = new Horizon.Server(testnetConfig.horizonUrl);
    const loaded = await withRetry('horizon loadAccount', () => horizon.loadAccount(kp.publicKey()));
    const native = loaded.balances.find((b) => b.asset_type === 'native');
    expect(Number(native?.balance ?? '0')).toBeGreaterThan(0);
  });
});
