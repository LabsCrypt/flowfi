/**
 * Live Stellar Testnet end-to-end: stream contract lifecycle + indexer ingestion.
 *
 * 1. Executes create_stream → withdraw → cancel_stream against the deployed
 *    contract (E2E_STREAM_CONTRACT_ID) using Friendbot-funded accounts and
 *    the native XLM Stellar Asset Contract.
 * 2. Runs the real SorobanEventWorker against the live RPC and a real
 *    Postgres (DATABASE_URL) and asserts the on-chain transactions were
 *    ingested with matching amounts, ledgers and tx hashes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { hasContract, hasDatabase, testnetConfig } from './helpers/config.js';
import {
  createFundedAccount,
  invokeContract,
  nativeTokenContractId,
  server,
  simulateRead,
  waitFor,
  type InvokeResult,
} from './helpers/soroban.js';

const DEPOSIT = 100_000_000n; // 10 XLM in stroops
const DURATION_SECS = 3_600n;

interface OnChainStream {
  sender: string;
  recipient: string;
  token_address: string;
  rate_per_second: bigint;
  deposited_amount: bigint;
  withdrawn_amount: bigint;
  is_active: boolean;
  status: unknown;
}

const u64 = (v: bigint | number) => nativeToScVal(v, { type: 'u64' });
const addr = (pk: string) => new Address(pk).toScVal();

/** Shared state across the ordered tests in this file. */
const run: {
  sender?: Keypair;
  recipient?: Keypair;
  token?: string;
  startLedger?: number;
  streamId?: bigint;
  created?: InvokeResult;
  withdrawn?: InvokeResult;
  withdrawnAmount?: bigint;
  cancelled?: InvokeResult;
} = {};

describe.skipIf(!hasContract())('Stellar Testnet: stream contract lifecycle', () => {
  const contractId = testnetConfig.contractId;

  beforeAll(async () => {
    // Sequential to stay under Friendbot's per-IP rate limit.
    run.sender = await createFundedAccount();
    run.recipient = await createFundedAccount();
    run.token = nativeTokenContractId();
    run.startLedger = (await server.getLatestLedger()).sequence;
  });

  it('contract is deployed and reachable', async () => {
    const res = await server.getContractWasmByContractId(contractId);
    expect(res.length).toBeGreaterThan(0);
  });

  it('create_stream succeeds and returns a stream id', async () => {
    const { sender, recipient, token } = run as Required<typeof run>;
    run.created = await invokeContract(sender, contractId, 'create_stream', [
      addr(sender.publicKey()),
      addr(recipient.publicKey()),
      addr(token),
      nativeToScVal(DEPOSIT, { type: 'i128' }),
      u64(DURATION_SECS),
    ]);
    expect(typeof run.created.returnValue).toBe('bigint');
    run.streamId = run.created.returnValue as bigint;
    console.info(
      `[testnet-e2e] stream_created id=${run.streamId} tx=${run.created.hash} ledger=${run.created.ledger}`,
    );
  });

  it('get_stream reflects the created stream', async () => {
    const { sender, recipient, token, streamId } = run as Required<typeof run>;
    const stream = (await simulateRead(sender, contractId, 'get_stream', [u64(streamId)])) as OnChainStream;
    expect(stream.sender).toBe(sender.publicKey());
    expect(stream.recipient).toBe(recipient.publicKey());
    expect(stream.token_address).toBe(token);
    expect(stream.is_active).toBe(true);
    // deposited_amount is net of protocol fee (if a fee config is set).
    expect(stream.deposited_amount).toBeGreaterThan(0n);
    expect(stream.deposited_amount).toBeLessThanOrEqual(DEPOSIT);
    expect(stream.rate_per_second).toBe(stream.deposited_amount / DURATION_SECS);
  });

  it('claimable amount accrues as ledgers close', async () => {
    const { sender, streamId } = run as Required<typeof run>;
    const claimable = await waitFor(
      'claimable amount > 0',
      async () => {
        const v = (await simulateRead(sender, contractId, 'get_claimable_amount', [u64(streamId)])) as
          | bigint
          | undefined;
        return v !== undefined && v > 0n ? v : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 3_000 },
    );
    expect(claimable).toBeGreaterThan(0n);
  });

  it('recipient can withdraw accrued tokens', async () => {
    const { recipient, streamId } = run as Required<typeof run>;
    run.withdrawn = await invokeContract(recipient, contractId, 'withdraw', [
      addr(recipient.publicKey()),
      u64(streamId),
    ]);
    run.withdrawnAmount = run.withdrawn.returnValue as bigint;
    expect(run.withdrawnAmount).toBeGreaterThan(0n);
  });

  it('sender can cancel the stream', async () => {
    const { sender, streamId } = run as Required<typeof run>;
    run.cancelled = await invokeContract(sender, contractId, 'cancel_stream', [
      addr(sender.publicKey()),
      u64(streamId),
    ]);
    const stream = (await simulateRead(sender, contractId, 'get_stream', [u64(streamId)])) as OnChainStream;
    expect(stream.is_active).toBe(false);
    expect(stream.status).toEqual(['Cancelled']);
    expect(stream.withdrawn_amount).toBeGreaterThanOrEqual(run.withdrawnAmount!);
  });

  it('contract events are queryable via getEvents', async () => {
    const { startLedger, created, withdrawn, cancelled } = run as Required<typeof run>;
    const hashes = new Set([created.hash, withdrawn.hash, cancelled.hash]);
    const found = await waitFor(
      'contract events for lifecycle txs',
      async () => {
        const res = await server.getEvents({
          startLedger,
          filters: [{ type: 'contract', contractIds: [contractId] }],
          limit: 200,
        });
        const mine = res.events.filter((e) => hashes.has(e.txHash));
        return mine.length >= 3 ? mine : undefined;
      },
      { timeoutMs: 60_000, intervalMs: 3_000 },
    );
    const txHashes = new Set(found.map((e) => e.txHash));
    expect(txHashes).toEqual(hashes);
  });

  // ─── Indexer drift ─────────────────────────────────────────────────────────

  describe.skipIf(!hasDatabase())('indexer ingestion into Postgres', () => {
    type Worker = import('../../src/workers/soroban-event-worker.js').SorobanEventWorker;
    type Prisma = typeof import('../../src/lib/prisma.js').prisma;
    let worker: Worker;
    let prisma: Prisma;

    beforeAll(async () => {
      // The worker reads its config in the constructor, so set env before import.
      process.env.STREAM_CONTRACT_ID = contractId;
      process.env.SOROBAN_RPC_URL = testnetConfig.rpcUrl;
      process.env.INDEXER_START_LEDGER = String(run.startLedger);
      // Drive polls manually; keep the background timer out of the way.
      process.env.INDEXER_POLL_INTERVAL_MS = String(60 * 60 * 1_000);

      ({ prisma } = await import('../../src/lib/prisma.js'));
      const { SorobanEventWorker } = await import('../../src/workers/soroban-event-worker.js');

      // Fresh cursor so ingestion starts at this run's first ledger.
      await prisma.indexerState.deleteMany({});
      worker = new SorobanEventWorker();
      await worker.start();
    });

    afterAll(async () => {
      worker?.stop();
      await worker?.waitForDrain();
      await prisma?.$disconnect();
    });

    it('ingests the stream and its CREATED / WITHDRAWN / CANCELLED events', async () => {
      const { streamId, created, withdrawn, cancelled, sender, recipient, token } =
        run as Required<typeof run>;
      expect(streamId, 'lifecycle tests must pass before indexer checks').toBeDefined();

      const events = await waitFor(
        `indexer to ingest stream ${streamId}`,
        async () => {
          await worker.triggerPoll();
          const rows = await prisma.streamEvent.findMany({ where: { streamId } });
          const types = new Set(rows.map((r) => r.eventType));
          return ['CREATED', 'WITHDRAWN', 'CANCELLED'].every((t) => types.has(t)) ? rows : undefined;
        },
        { timeoutMs: testnetConfig.indexerTimeoutMs, intervalMs: 3_000 },
      );

      const byType = Object.fromEntries(events.map((e) => [e.eventType, e]));
      expect(byType.CREATED!.transactionHash).toBe(created.hash);
      expect(byType.CREATED!.ledgerSequence).toBe(created.ledger);
      expect(byType.WITHDRAWN!.transactionHash).toBe(withdrawn.hash);
      expect(byType.WITHDRAWN!.amount).toBe(run.withdrawnAmount!.toString());
      expect(byType.CANCELLED!.transactionHash).toBe(cancelled.hash);

      const stream = await prisma.stream.findUniqueOrThrow({ where: { streamId } });
      expect(stream.sender).toBe(sender.publicKey());
      expect(stream.recipient).toBe(recipient.publicKey());
      expect(stream.tokenAddress).toBe(token);
      expect(stream.isActive).toBe(false);
      expect(BigInt(stream.withdrawnAmount)).toBeGreaterThanOrEqual(run.withdrawnAmount!);

      // No events from this run should have been dead-lettered.
      const deadLetters = await prisma.indexerDeadLetterEvent.findMany({
        where: { transactionHash: { in: [created.hash, withdrawn.hash, cancelled.hash] } },
      });
      expect(deadLetters).toEqual([]);
      expect(worker.getEventCounters().eventsFailed).toBe(0);
    });
  });
});
