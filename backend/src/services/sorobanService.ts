import { rpc, xdr, StrKey, Contract, nativeToScVal, Keypair, TransactionBuilder, Transaction, Networks, Account, Address } from '@stellar/stellar-sdk';
import logger from '../logger.js';
import { ApiError } from '../lib/api-error.js';
import { rpcPool } from '../lib/rpc-pool.js';
import {
  recordRpcRequest,
  rpcCircuitBreakerTripsTotal,
  rpcFailoversTotal,
} from '../lib/metrics.js';
import { withSpan } from '../lib/tracing.js';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

function getContractId(): string {
  return process.env.STREAM_CONTRACT_ID ?? '';
}

function getKeeperSecret(): string {
  return process.env.KEEPER_SECRET_KEY ?? '';
}

/** Passphrase of the network this service signs for. */
function networkPassphrase(): string {
  return process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}
/**
 * DB data older than this is considered stale and triggers an RPC fallback.
 * 30 s ≈ avg Stellar ledger close time (~5 s) × 6 ledgers — a reasonable
 * window to tolerate indexer lag without hammering the RPC on every request.
 */
const STALE_THRESHOLD_MS = 30_000;

/** Stroops charged on read-only simulation transactions (no real resource cost). */
const SIMULATION_FEE = '100';

/** Stroops charged on real contract-invocation transactions submitted to the network. */
const SUBMIT_FEE = '1000';

/** Transaction validity window in seconds (applied via setTimeout). */
const TX_TIMEOUT_SECONDS = 30;

/** Bounded, configurable deadline applied to every outbound Soroban RPC call. */
const RPC_TIMEOUT_MS = Number(process.env.SOROBAN_RPC_TIMEOUT_MS ?? 10_000);

/** Max retry attempts for transient RPC failures (in addition to the first try). */
const RPC_MAX_RETRIES = Number(process.env.SOROBAN_RPC_MAX_RETRIES ?? 2);

/** Base delay for exponential backoff between retries (doubles each attempt). */
const RPC_RETRY_BASE_MS = Number(process.env.SOROBAN_RPC_RETRY_BASE_MS ?? 250);

/** Bounded deadline for awaiting on-chain transaction finality (default 30s). */
function getTxConfirmationTimeoutMs(): number {
  return Number(process.env.SOROBAN_TX_CONFIRMATION_TIMEOUT_MS ?? 30_000);
}

/** Polling interval when awaiting on-chain transaction finality (default 1s). */
function getTxPollIntervalMs(): number {
  return Number(process.env.SOROBAN_TX_POLL_INTERVAL_MS ?? 1_000);
}

const DEFAULT_RPC_HEALTH_CACHE_TTL_MS = 10_000;

let rpcHealthCache: { ok: boolean; expiresAt: number } | null = null;
let rpcHealthPromise: Promise<boolean> | null = null;

function getRpcHealthCacheTtlMs(): number {
  return Number(process.env.SOROBAN_RPC_HEALTH_CACHE_TTL_MS ?? DEFAULT_RPC_HEALTH_CACHE_TTL_MS);
}

export function resetRpcHealthCache(): void {
  rpcHealthCache = null;
  rpcHealthPromise = null;
}

export class RpcTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
  }
}

function isTransientRpcError(err: unknown): boolean {
  if (err instanceof RpcTimeoutError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|\b50[234]\b/i.test(
    message,
  );
}

/**
 * Bound an RPC call with a configurable deadline. The call is raced against a
 * timer so a hung endpoint can never stall the indexer poll loop or a request
 * handler indefinitely; `signal` is passed through so raw `fetch` calls can
 * genuinely cancel the in-flight request (SDK calls that don't accept a
 * signal simply ignore it and the race abandons them on timeout).
 */
export async function withRpcTimeout<T>(
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RpcTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await withSpan('rpc.' + label, { 'rpc.system': 'stellar', 'rpc.method': label }, async (span) => {
      try {
        const result = await Promise.race([fn(controller.signal), timedOut]);
        recordRpcRequest(label, (Date.now() - start) / 1000, 'success');
        return result;
      } catch (err) {
        const outcome = err instanceof RpcTimeoutError ? 'timeout' : 'error';
        recordRpcRequest(label, (Date.now() - start) / 1000, outcome);
        if (outcome === 'timeout') {
          rpcCircuitBreakerTripsTotal.inc({ endpoint: rpcEndpointLabel(), method: label });
        }
        span.setAttributes({ 'rpc.error': err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  } finally {
    clearTimeout(timer!);
    const elapsedMs = Date.now() - start;
    if (elapsedMs >= timeoutMs) {
      logger.warn(
        `[SorobanService] RPC latency exceeded timeout: ${label} took ${elapsedMs}ms (timeout=${timeoutMs}ms)`,
      );
    }
  }
}

/** Retry a transient RPC failure with exponential backoff. */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries: number = RPC_MAX_RETRIES,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries) {
        // The call chain is exhausted: treat it as a breaker trip so operators
        // can see when an endpoint is effectively down.
        rpcCircuitBreakerTripsTotal.inc({ endpoint: rpcEndpointLabel(), method: label });
        throw err;
      }
      if (!isTransientRpcError(err)) throw err;
      // A retry is a failover event. When multi-RPC rotation lands, extend this
      // with the endpoint actually promoted.
      rpcFailoversTotal.inc({ method: label });
      const backoffMs = RPC_RETRY_BASE_MS * 2 ** (attempt - 1);
      logger.warn(
        `[SorobanService] ${label} attempt ${attempt}/${maxRetries} failed (${
          err instanceof Error ? err.message : String(err)
        }); retrying in ${backoffMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/**
 * Low-cardinality label for the configured RPC endpoint — Prometheus would
 * otherwise see a new series per distinct URL (and query string) in the fleet.
 */
export function rpcEndpointLabel(): string {
  try {
    return new URL(RPC_URL).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Throw-away source account used when building simulation-only transactions.
 *
 * Any valid Ed25519 public key works here; the account never needs to exist
 * on-chain because simulation transactions are never submitted. This one is
 * derived deterministically from an all-zero seed so it is obviously not a
 * real user, and `new Account()` accepts it — an account ID that fails
 * StrKey validation would throw inside the fallback path and turn a graceful
 * degradation into a 500.
 */
const SIMULATION_PLACEHOLDER_ACCOUNT = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';

let _server: rpc.Server | null = null;

async function executeRpc<T>(label: string, operation: (server: rpc.Server) => Promise<T>): Promise<T> {
  if (_server) return operation(_server);
  return rpcPool.execute(label, (server) => operation(server));
}

/**
 * Lightweight connectivity check used by the /health endpoint.
 * Calls the RPC server's getHealth() with a bounded timeout so a slow or
 * unreachable Soroban RPC endpoint can't hang the health check.
 */
export async function checkRpcHealth(timeoutMs = 3_000): Promise<boolean> {
  const now = Date.now();
  const ttlMs = getRpcHealthCacheTtlMs();

  if (rpcHealthCache && now < rpcHealthCache.expiresAt) {
    return rpcHealthCache.ok;
  }

  if (rpcHealthPromise) {
    return rpcHealthPromise;
  }

  rpcHealthPromise = (async () => {
    try {
      const ok = await withRpcTimeout(
        'soroban rpc health check',
        () => executeRpc('soroban rpc health check', (server) => server.getHealth()),
        timeoutMs,
      );
      const result = Boolean(ok);
      rpcHealthCache = { ok: result, expiresAt: Date.now() + ttlMs };
      return result;
    } catch {
      rpcHealthCache = { ok: false, expiresAt: Date.now() + ttlMs };
      return false;
    } finally {
      rpcHealthPromise = null;
    }
  })();

  return rpcHealthPromise;
}

export function setServer(server: rpc.Server): void {
  _server = server;
}

export function resetServer(): void {
  _server = null;
}

export interface ChainStream {
  streamId: bigint;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  isActive: boolean;
}

export function decodeI128(val: xdr.ScVal): string {
  const parts = (val as xdr.ScValI128).i128;
  const hi = BigInt.asIntN(64, BigInt(parts.hi.toString()));
  const lo = BigInt.asUintN(64, BigInt(parts.lo.toString()));
  return ((hi << 64n) | lo).toString();
}

export function decodeAddress(val: xdr.ScVal): string {
  const addr = (val as xdr.ScValAddress).address;
  if (addr.type === 'scAddressTypeAccount') {
    return StrKey.encodeEd25519PublicKey((addr.accountId as xdr.PublicKeyEd25519).ed25519.value);
  }
  const hash = (addr as xdr.ScAddressContract).contractId;
  return StrKey.encodeContract(Buffer.from(hash.value as unknown as Uint8Array));
}

function decodeMap(val: xdr.ScVal): Record<string, xdr.ScVal> {
  const result: Record<string, xdr.ScVal> = {};
  for (const entry of (val as xdr.ScValMap).map ?? []) {
    result[(entry.key as xdr.ScValSymbol).sym.toString()] = entry.val;
  }
  return result;
}

async function simulateContractCall(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const contract = new Contract(getContractId());

  const op = contract.call(method, ...args);

  const tx = new TransactionBuilder(
    // Read-only simulations don't consume a real source account; use a valid
    // placeholder so Account construction never throws.
    new Account(SIMULATION_PLACEHOLDER_ACCOUNT, '0'),
    {
      fee: SIMULATION_FEE,
      networkPassphrase:
        process.env.STELLAR_NETWORK === 'mainnet'
          ? Networks.PUBLIC
          : Networks.TESTNET,
    }
  )
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  const result = await withRpcRetry('simulateTransaction', () =>
    withRpcTimeout('simulateTransaction', () => executeRpc('simulateTransaction', (server) => server.simulateTransaction(tx))),
  );

  if (rpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }

  const simSuccess = result as rpc.Api.SimulateTransactionSuccessResponse;
  return simSuccess.result!.retval;
}

/**
 * Build, sign and submit a contract invocation with the **server keeper key**.
 *
 * The only key the backend is allowed to hold is `KEEPER_SECRET_KEY`, and the
 * only actions it may perform with it are the ones the contract authorizes for
 * the keeper (see `topUpStream`). Anything a user authorizes for themselves —
 * `cancel_stream` calls `sender.require_auth()` — cannot be signed here and
 * must come back as a wallet-signed transaction instead
 * (`submitSignedCancel`).
 *
 * A caller-supplied secret key is never accepted (issue #1845): shipping a
 * wallet's `S…` key over the API exposes it to logs, proxies, memory dumps and
 * any compromised host, and it contradicts the client-side-signing direction
 * recorded in issue #1274.
 */
export async function submitContractCall(method: string, args: xdr.ScVal[]): Promise<string> {
  const contractId = getContractId();
  if (!contractId) throw new Error('CONTRACT_ID not set');

  const keeperSecret = getKeeperSecret();
  if (!keeperSecret) throw new Error('KEEPER_SECRET_KEY not configured');

  const keypair = Keypair.fromSecret(keeperSecret);
  const contract = new Contract(contractId);
  const account = await withRpcTimeout('getAccount', () => executeRpc('getAccount', (server) => server.getAccount(keypair.publicKey())));

  const op = contract.call(method, ...args);

  const tx = new TransactionBuilder(account, {
    fee: SUBMIT_FEE,
    networkPassphrase:
      process.env.STELLAR_NETWORK === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  // Simulate first to get foot print and resource info
  const simulation = await withRpcRetry('simulateTransaction', () =>
    withRpcTimeout('simulateTransaction', () => executeRpc('simulateTransaction', (server) => server.simulateTransaction(tx))),
  );
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // Assemble transaction with simulation results
  const assembledTx = rpc.assembleTransaction(tx, simulation).build();
  assembledTx.sign(keypair);

  const response = await withRpcTimeout('sendTransaction', () => executeRpc('sendTransaction', (server) => server.sendTransaction(assembledTx)));

  if (response.status === 'ERROR') {
    throw new Error(`Transaction failed: ${JSON.stringify(response.errorResult)}`);
  }

  await pollTransactionStatus(response.hash);

  return response.hash;
}

/**
 * Poll a submitted transaction until it reaches a final on-chain state.
 *
 * `sendTransaction` only queues the transaction; without this wait a caller
 * could immediately read chain state and see a pre-transaction view. Returns
 * the final successful transaction response, or throws when the transaction
 * fails on-chain or the confirmation window lapses.
 *
 * Poll Soroban RPC getTransaction until the transaction reaches a terminal
 * status (SUCCESS or FAILED) or until the bounded timeout expires.
 */
export async function pollTransactionStatus(
  txHash: string,
  timeoutMs: number = getTxConfirmationTimeoutMs(),
  pollIntervalMs: number = getTxPollIntervalMs(),
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const txResponse = await withRpcRetry('getTransaction', () =>
      withRpcTimeout('getTransaction', () => executeRpc('getTransaction', (server) => server.getTransaction(txHash))),
    );

    if (
      txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS ||
      (txResponse.status as string) === 'SUCCESS'
    ) {
      return txResponse as rpc.Api.GetSuccessfulTransactionResponse;
    }

    if (
      txResponse.status === rpc.Api.GetTransactionStatus.FAILED ||
      (txResponse.status as string) === 'FAILED'
    ) {
      const failed = txResponse as rpc.Api.GetFailedTransactionResponse;
      const errorDetail = failed.resultXdr
        ? ` (resultXdr: ${failed.resultXdr.toXDR('base64')})`
        : '';
      throw new Error(`Transaction failed on-chain: ${txHash}${errorDetail}`);
    }

    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error(`Transaction confirmation timed out after ${timeoutMs}ms: ${txHash}`);
}

/**
 * Latest ledger sequence known to the network, or 0 when it cannot be resolved.
 *
 * Feeds the `flowfi_indexer_network_ledger` gauge so `flowfi_indexer_lag_ledgers`
 * has a denominator even between indexer poll cycles.
 */
export async function getLatestLedger(): Promise<number> {
  try {
    const response = await withRpcRetry('getLatestLedger', () =>
      withRpcTimeout('getLatestLedger', () => executeRpc('getLatestLedger', (server) => server.getLatestLedger())),
    );
    return Number(response.sequence);
  } catch (err) {
    logger.warn('[SorobanService] getLatestLedger failed:', err);
    return 0;
  }
}

export async function getStreamFromChain(streamId: bigint): Promise<ChainStream | null> {
  if (!getContractId()) return null;

  try {
    const retval = await simulateContractCall('get_stream', [
      nativeToScVal(streamId, { type: 'u64' }),
    ]);

    const fields = decodeMap(retval);

    const isActiveVal = fields['is_active']!;
    const isActive =
      isActiveVal.type === 'scvBool' &&
      isActiveVal.b === true;

    return {
      streamId,
      sender: decodeAddress(fields['sender']!),
      recipient: decodeAddress(fields['recipient']!),
      tokenAddress: decodeAddress(fields['token_address']!),
      ratePerSecond: decodeI128(fields['rate_per_second']!),
      depositedAmount: decodeI128(fields['deposited_amount']!),
      withdrawnAmount: decodeI128(fields['withdrawn_amount']!),
      startTime: Number((fields['start_time']! as xdr.ScValU64).u64.toString()),
      isActive,
    };
  } catch (err) {
    logger.error(`[SorobanService] getStreamFromChain(${streamId}) failed:`, err);
    return null;
  }
}

export async function getClaimableFromChain(streamId: bigint): Promise<string | null> {
  if (!getContractId()) return null;

  try {
    const retval = await simulateContractCall('get_claimable_amount', [
      nativeToScVal(streamId, { type: 'u64' }),
    ]);

    return decodeI128(retval);
  } catch (err) {
    logger.error(`[SorobanService] getClaimableFromChain(${streamId}) failed:`, err);
    return null;
  }
}

/**
 * Cancel a stream using a transaction the sender's wallet already signed.
 *
 * The contract authorizes `cancel_stream` with `sender.require_auth()`, so only
 * the sender's key can sign it and the backend must never be shown that key.
 * The flow is therefore: `simulateStreamAction('cancel', …)` hands the client an
 * unsigned, footprint-annotated XDR, the wallet signs it, and this function
 * validates the signature envelope and relays it.
 *
 * Validation is not cosmetic: the returned hash is written into the DB as proof
 * the stream was cancelled, so the envelope has to be *this* stream's cancel and
 * nobody else's transaction.
 *
 * @returns The real transaction hash, once the submission is confirmed.
 */
export async function submitSignedCancel(
  signedXdr: string,
  expected: { streamId: bigint; senderAddress: string },
): Promise<string> {
  const tx = inspectSignedCancelEnvelope(signedXdr, expected);
  return submitRelayedTransaction(tx);
}

/**
 * Decode a wallet-signed cancel and prove it is the cancel the caller claims.
 *
 * Pure and offline: no RPC, no signing. Throws `ApiError(400)` with code
 * `SIGNED_TX_INVALID` (malformed/not signed/not a cancel) or `SIGNED_TX_MISMATCH`
 * (right shape, wrong stream or wrong sender).
 */
export function inspectSignedCancelEnvelope(
  signedXdr: string,
  expected: { streamId: bigint; senderAddress: string },
): Transaction {
  if (typeof signedXdr !== 'string' || signedXdr.trim() === '') {
    throw signedTxInvalid('signedXdr is required: sign the transaction from POST /v1/streams/simulate.');
  }

  const contractId = getContractId();
  if (!contractId) throw new Error('CONTRACT_ID not set');

  let tx: Transaction;
  try {
    tx = new Transaction(signedXdr, networkPassphrase());
  } catch (err) {
    throw signedTxInvalid(
      `signedXdr is not a valid signed transaction for this network: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const signatures = readEnvelopeSignatures(signedXdr);
  if (signatures.length === 0) {
    throw signedTxInvalid('signedXdr carries no signatures; the wallet must sign it first.');
  }

  const operations = tx.operations;
  if (operations.length !== 1) {
    throw signedTxInvalid(
      `A relayed cancel must contain exactly one operation, found ${operations.length}.`,
    );
  }

  const invocation = readInvokeContract(operations[0]);
  if (!invocation) {
    throw signedTxInvalid('The operation is not a contract invocation.');
  }

  if (invocation.contractId !== contractId) {
    throw signedTxMismatch(
      'The transaction calls a contract other than the configured stream contract.',
      { expected: contractId, actual: invocation.contractId },
    );
  }

  if (invocation.functionName !== 'cancel_stream') {
    throw signedTxMismatch('The transaction is not a `cancel_stream` call.', {
      expected: 'cancel_stream',
      actual: invocation.functionName,
    });
  }

  const [signerArg, streamIdArg] = invocation.args;
  if (!signerArg || !streamIdArg) {
    throw signedTxMismatch(
      'cancel_stream expects two arguments: the sender address and the stream id.',
      { args: invocation.args.length },
    );
  }

  if (decodeAddress(signerArg) !== expected.senderAddress) {
    throw signedTxMismatch(
      'The transaction authorizes a sender other than the authenticated caller.',
      { expected: expected.senderAddress, actual: decodeAddress(signerArg) },
    );
  }

  if (streamIdArg.type !== 'scvU64' || streamIdArg.u64 !== expected.streamId) {
    throw signedTxMismatch('The transaction cancels a different stream than requested.', {
      expected: expected.streamId.toString(),
      actual: streamIdArg.type === 'scvU64' ? streamIdArg.u64.toString() : streamIdArg.type,
    });
  }

  if (tx.source !== expected.senderAddress) {
    throw signedTxMismatch(
      'The transaction source account must be the stream sender (the wallet that signed it).',
      { expected: expected.senderAddress, actual: tx.source },
    );
  }

  return tx;
}

/**
 * Relay an already-signed transaction: submit it, await finality, return the
 * hash. Deliberately does no simulation — the wallet signed the exact bytes that
 * go on the wire, and re-simulating could reprice them.
 */
async function submitRelayedTransaction(tx: Transaction): Promise<string> {
  const response = await withRpcTimeout('sendTransaction', () =>
    executeRpc('sendTransaction', (server) => server.sendTransaction(tx)),
  );

  if (response.status === 'ERROR') {
    throw new Error(
      `Relayed transaction rejected on-chain: ${JSON.stringify(response.errorResult)}`,
    );
  }

  await pollTransactionStatus(response.hash);
  return response.hash;
}

function signedTxInvalid(message: string): ApiError {
  return new ApiError(400, 'SIGNED_TX_INVALID', message);
}

function signedTxMismatch(message: string, details: unknown): ApiError {
  return new ApiError(400, 'SIGNED_TX_MISMATCH', message, details);
}

/** Signatures on the envelope, read straight from the base64 XDR. */
function readEnvelopeSignatures(xdrBase64: string): xdr.DecoratedSignature[] {
  // SDK 17 models unions as subclasses with property arms (`type` / `v1`),
  // not `switch()` / `v1()` methods. A fee-bump envelope is rejected rather
  // than unwrapped: its inner transaction would need the same checks, and the
  // cancel flow never produces one.
  const envelope = xdr.TransactionEnvelope.fromXDR(xdrBase64, 'base64');
  if (envelope.type !== 'envelopeTypeTx') {
    throw signedTxInvalid('Expected a `envelopeTypeTx` transaction envelope.');
  }
  return envelope.v1.signatures;
}

/**
 * Read the contract invocation out of a marshalled operation, or `null` when the
 * operation is not a Soroban contract call.
 */
function readInvokeContract(
  operation: unknown,
): { contractId: string; functionName: string; args: xdr.ScVal[] } | null {
  const invoke = (
    operation as {
      func?: {
        invokeContract?: {
          contractAddress: { contractId: { value: Uint8Array } };
          functionName: string;
          args?: xdr.ScVal[];
        };
      };
    }
  )?.func?.invokeContract;
  if (!invoke) return null;
  return {
    contractId: StrKey.encodeContract(Buffer.from(invoke.contractAddress.contractId.value)),
    functionName: invoke.functionName.toString(),
    args: invoke.args ?? [],
  };
}

export async function topUpStream(streamId: bigint, amount: bigint, callerAddress: string): Promise<string> {
  return submitContractCall('top_up_stream', [
    nativeToScVal(streamId, { type: 'u64' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(callerAddress, { type: 'address' }),
  ]);
}

/** Returns true when the DB record is older than STALE_THRESHOLD_MS. */
export function isStale(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() > STALE_THRESHOLD_MS;
}

/**
 * Result of a simulation-only stream action (pause, resume, withdraw).
 *
 * These actions are authorized by the wallet that owns them — the contract
 * calls `require_auth` on the sender/recipient — so the backend can only dry-run
 * them. Nothing is submitted, so nothing is returned that looks like a
 * transaction: `txHash` deliberately does not exist on this type. A caller that
 * wants the real thing signs the XDR from `simulateStreamAction` (issue #1847).
 */
export interface SimulatedActionResult {
  simulated: true;
  /** The contract function that was dry-run, echoed for client messaging. */
  fn: 'pause_stream' | 'resume_stream' | 'withdraw';
}

/**
 * Dry-run the contract's `pause_stream` for a sender.
 *
 * Read-only: it proves the call would succeed and nothing else. The pause
 * itself must be signed by the sender's wallet and submitted by the client, so
 * no database state may be derived from this function's result.
 */
export async function pauseStream(
  senderAddress: string,
  streamId: bigint
): Promise<SimulatedActionResult> {
  if (!getContractId()) {
    throw new Error('Stream contract ID not configured');
  }

  try {
    const { Address } = await import('@stellar/stellar-sdk');

    const senderAddr = new Address(senderAddress);

    await simulateContractCall('pause_stream', [
      senderAddr.toScVal(),
      nativeToScVal(streamId, { type: 'u64' }),
    ]);

    return { simulated: true, fn: 'pause_stream' };
  } catch (err) {
    logger.error(`[SorobanService] pauseStream(${streamId}) failed:`, err);
    throw new Error(`Failed to pause stream: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Dry-run the contract's `resume_stream` for a sender. See `pauseStream` for
 * why the result carries no transaction hash.
 */
export async function resumeStream(
  senderAddress: string,
  streamId: bigint
): Promise<SimulatedActionResult> {
  if (!getContractId()) {
    throw new Error('Stream contract ID not configured');
  }

  try {
    const { Address } = await import('@stellar/stellar-sdk');

    const senderAddr = new Address(senderAddress);

    await simulateContractCall('resume_stream', [
      senderAddr.toScVal(),
      nativeToScVal(streamId, { type: 'u64' }),
    ]);

    return { simulated: true, fn: 'resume_stream' };
  } catch (err) {
    logger.error(`[SorobanService] resumeStream(${streamId}) failed:`, err);
    throw new Error(`Failed to resume stream: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Dry-run the contract's `withdraw` for a recipient.
 *
 * The indexer is the authoritative writer of `withdrawnAmount` and WITHDRAWN
 * events, because only the on-chain event proves the funds actually moved. This
 * function therefore proves nothing more than "the call would succeed".
 */
export async function withdraw(
  streamId: bigint,
  recipientAddress: string,
): Promise<SimulatedActionResult> {
  if (!getContractId()) {
    throw new Error('Stream contract ID not configured');
  }

  try {
    const { Address } = await import('@stellar/stellar-sdk');

    const recipient = new Address(recipientAddress);

    await simulateContractCall('withdraw', [
      recipient.toScVal(),
      nativeToScVal(streamId, { type: 'u64' }),
    ]);

    return { simulated: true, fn: 'withdraw' };
  } catch (err) {
    logger.error(`[SorobanService] withdraw(${streamId}) failed:`, err);
    throw new Error(`Failed to withdraw from stream: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

// ─── Client-side signing support (issue #1274) ────────────────────────────────
//
// FlowFi is deprecating backend keeper signing in favour of client-side
// signing (Freighter / Lobstr / xBull). Those wallets cannot compute a Soroban
// footprint on their own, so this module exposes an authoritative simulation
// endpoint: the client posts the action it intends to take and receives back an
// unsigned, footprint-annotated transaction plus a padded resource fee.

export type StreamAction =
  | 'create'
  | 'withdraw'
  | 'cancel'
  | 'top_up'
  | 'batch_withdraw';

/**
 * Action-specific simulation arguments.
 *
 * Properties are explicitly `| undefined` because `exactOptionalPropertyTypes`
 * is on: a zod-inferred optional field arrives as `string | undefined`, which
 * is not assignable to a bare `?:` property.
 */
export interface SimulateActionParams {
  streamId?: string | undefined;
  streamIds?: string[] | undefined;
  recipient?: string | undefined;
  amount?: string | undefined;
  duration?: number | undefined;
  tokenAddress?: string | undefined;
}

export interface StreamSimulationResult {
  /** Base64 XDR, assembled with the simulation footprint + resource fee, unsigned. */
  unsignedXdr: string;
  /** Minimum resource fee reported by the RPC, in stroops. */
  minResourceFee: string;
  /** `minResourceFee` plus a safety buffer, in stroops. */
  recommendedFee: string;
  cpuInstructions: number;
  memoryBytes: number;
  /** Last ledger the returned footprint is valid against. */
  expiresAtLedger: number;
  /** Decoded contract return value, as a decimal string (empty when void). */
  simulatedReturn: string;
}

/**
 * Safety buffer applied to the simulated resource fee.
 *
 * Simulation measures the exact footprint of the state as of `latestLedger`.
 * Anything that changes the footprint before submission (a concurrent top-up,
 * a fee-config update, a new stream) invalidates it, and the network then
 * rejects the transaction for insufficient resources. 15% absorbs the common
 * cases without meaningfully overpaying.
 */
export const FEE_BUFFER_PERCENT = 15;

/** Default number of ledgers a returned simulation stays fresh for (~50 s). */
const SIMULATION_VALIDITY_LEDGERS = Number(
  process.env.SIMULATION_VALIDITY_LEDGERS ?? 10,
);

/**
 * Soroban contract error codes declared by `StreamError` in
 * contracts/stream_contract/src/errors.rs, paired with a remediation hint the
 * client can show verbatim.
 */
const CONTRACT_ERROR_HINTS: Record<number, { message: string; hint: string }> = {
  1: { message: 'Amount must be greater than zero', hint: 'Enter an amount above 0 stroops.' },
  2: { message: 'Stream not found', hint: 'Refresh the stream list — this stream may have been cancelled or never existed on-chain.' },
  3: { message: 'Caller is not authorized for this stream', hint: 'Only the stream sender can cancel or top up; only the recipient can withdraw.' },
  4: { message: 'Stream is not active', hint: 'The stream was cancelled or fully withdrawn and cannot be modified.' },
  5: { message: 'Protocol is already initialized', hint: 'This is a configuration action that can only be performed once.' },
  6: { message: 'Caller is not the protocol admin', hint: 'Connect the admin wallet to perform this action.' },
  7: { message: 'Fee rate exceeds the protocol maximum', hint: 'The fee rate must be at most 1000 bps (10%).' },
  8: { message: 'Protocol config is not initialized', hint: 'The stream contract has not been initialized on this network yet.' },
  9: { message: 'Duration must be greater than zero', hint: 'Set a stream duration of at least 1 second.' },
  10: { message: 'Invalid token contract address', hint: 'Provide a deployed SEP-41 token contract address.' },
  11: { message: 'Rate rounds to zero', hint: 'Increase the amount or shorten the duration so amount / duration is at least 1 stroop per second.' },
  12: { message: 'Stream is paused', hint: 'Resume the stream before performing this action.' },
  13: { message: 'Stream is not paused', hint: 'Only a paused stream can be resumed.' },
  14: { message: 'Stream is already paused', hint: 'This stream is already paused.' },
};

/** Extract a numeric `StreamError` code out of an RPC/diagnostic error string. */
export function parseContractErrorCode(raw: string): number | null {
  // Soroban surfaces contract errors as "HostError: Error(Contract, #N)" in
  // simulation diagnostics; older nodes use "contract trapped" + the code.
  const hostError = /Error\(Contract,\s*#(\d+)\)/i.exec(raw);
  if (hostError?.[1]) return Number(hostError[1]);

  const trapped = /contract trapped[^\d]{0,40}?#?(\d{1,4})/i.exec(raw);
  if (trapped?.[1]) return Number(trapped[1]);

  return null;
}

/**
 * Convert a failed simulation into a typed 400 ApiError carrying the decoded
 * contract error and a remediation hint.
 */
export function toSimulationApiError(
  rawError: string,
  action: StreamAction,
): ApiError {
  const code = parseContractErrorCode(rawError);
  const known = code !== null ? CONTRACT_ERROR_HINTS[code] : undefined;

  const message = known
    ? known.message
    : `Simulation of "${action}" failed: ${rawError}`;

  return new ApiError(400, 'simulation_failed', message, {
    action,
    reason: rawError,
    ...(code !== null ? { contractErrorCode: code } : {}),
    ...(known ? { hint: known.hint } : {}),
  });
}

function toStreamId(raw: string | undefined, field: string): bigint {
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError(400, 'invalid_params', `${field} is required`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(400, 'invalid_params', `${field} must be a non-negative integer string`);
  }
  return BigInt(raw);
}

function toPositiveI128(raw: string | undefined, field: string): bigint {
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError(400, 'invalid_params', `${field} is required`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(400, 'invalid_params', `${field} must be a positive integer string`);
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new ApiError(400, 'invalid_params', `${field} must be greater than zero`);
  }
  return value;
}

function toAddress(raw: string | undefined, field: string): Address {
  if (!raw) {
    throw new ApiError(400, 'invalid_params', `${field} is required`);
  }
  try {
    return new Address(raw);
  } catch {
    throw new ApiError(400, 'invalid_params', `${field} is not a valid Stellar address`);
  }
}

/** A single contract invocation within a simulation transaction. */
interface Invocation {
  method: string;
  args: xdr.ScVal[];
}

function buildInvocations(
  action: StreamAction,
  sender: Address,
  params: SimulateActionParams,
): Invocation[] {
  switch (action) {
    case 'create': {
      const recipient = toAddress(params.recipient, 'params.recipient');
      const tokenAddressRaw =
        params.tokenAddress ?? process.env.STREAM_TOKEN_ADDRESS ?? '';
      const tokenAddress = toAddress(tokenAddressRaw, 'params.tokenAddress');
      const amount = toPositiveI128(params.amount, 'params.amount');

      if (params.duration === undefined || !Number.isInteger(params.duration) || params.duration <= 0) {
        throw new ApiError(
          400,
          'invalid_params',
          'params.duration must be a positive integer (seconds)',
        );
      }

      return [
        {
          method: 'create_stream',
          args: [
            sender.toScVal(),
            recipient.toScVal(),
            tokenAddress.toScVal(),
            nativeToScVal(amount, { type: 'i128' }),
            nativeToScVal(BigInt(params.duration), { type: 'u64' }),
          ],
        },
      ];
    }

    case 'withdraw': {
      return [
        {
          method: 'withdraw',
          args: [
            sender.toScVal(),
            nativeToScVal(toStreamId(params.streamId, 'params.streamId'), { type: 'u64' }),
          ],
        },
      ];
    }

    case 'cancel': {
      return [
        {
          method: 'cancel_stream',
          args: [
            sender.toScVal(),
            nativeToScVal(toStreamId(params.streamId, 'params.streamId'), { type: 'u64' }),
          ],
        },
      ];
    }

    case 'top_up': {
      return [
        {
          method: 'top_up_stream',
          args: [
            sender.toScVal(),
            nativeToScVal(toStreamId(params.streamId, 'params.streamId'), { type: 'u64' }),
            nativeToScVal(toPositiveI128(params.amount, 'params.amount'), { type: 'i128' }),
          ],
        },
      ];
    }

    case 'batch_withdraw': {
      const ids = params.streamIds ?? (params.streamId ? [params.streamId] : undefined);
      if (!ids || ids.length === 0) {
        throw new ApiError(
          400,
          'invalid_params',
          'params.streamIds is required for batch_withdraw',
        );
      }
      if (ids.length > MAX_BATCH_WITHDRAW) {
        throw new ApiError(
          400,
          'invalid_params',
          `batch_withdraw accepts at most ${MAX_BATCH_WITHDRAW} streams per transaction`,
        );
      }
      // The contract has no batch entrypoint, so each stream becomes its own
      // withdraw operation inside one transaction. The whole tx still has to
      // succeed, so one failing stream reverts the batch.
      return ids.map((id) => ({
        method: 'withdraw',
        args: [sender.toScVal(), nativeToScVal(toStreamId(id, 'params.streamIds[]'), { type: 'u64' })],
      }));
    }

    default: {
      const exhaustive: never = action;
      throw new ApiError(400, 'invalid_params', `Unsupported action: ${String(exhaustive)}`);
    }
  }
}

/** Upper bound on operations in a batch_withdraw simulation. */
const MAX_BATCH_WITHDRAW = 10;

/** Apply the fee buffer, rounding up so the result is never short. */
export function applyFeeBuffer(minResourceFee: string): string {
  const base = BigInt(minResourceFee || '0');
  const padded = (base * BigInt(100 + FEE_BUFFER_PERCENT)) / 100n;
  return (padded > base ? padded : base + 1n).toString();
}

/**
 * Read the CPU instruction and memory footprints out of a simulation result.
 *
 * Soroban reports `instructions` (CPU) and `writeBytes` (the write footprint
 * that bounds transaction memory); `readBytes` is billed separately as disk
 * reads, so it is deliberately not folded into `memoryBytes`.
 */
function readResourceFootprint(
  transactionData: rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
): { cpuInstructions: number; memoryBytes: number } {
  try {
    const data = transactionData.build();
    const resources = data.resources;
    return {
      cpuInstructions: Number(resources.instructions),
      memoryBytes: Number(resources.writeBytes),
    };
  } catch (err) {
    logger.warn('[SorobanService] Could not read resource footprint from simulation:', err);
    return { cpuInstructions: 0, memoryBytes: 0 };
  }
}

/** Render a simulated ScVal return as a decimal string ('' for void returns). */
function decodeSimulatedReturn(result: rpc.Api.SimulateTransactionSuccessResponse): string {
  const retval = result.result?.retval;
  if (!retval) return '';

  try {
    // SDK 17 models ScVal as a discriminated union keyed on `type`; each
    // variant exposes its arm payload via the `value` getter.
    switch (retval.type) {
      case 'scvI128':
        return decodeI128(retval);
      case 'scvU64':
        return retval.value.toString();
      case 'scvU32':
        return retval.value.toString();
      case 'scvI64':
        return retval.value.toString();
      case 'scvU128': {
        const parts = retval.value;
        const hi = BigInt.asUintN(64, BigInt(parts.hi.toString()));
        const lo = BigInt.asUintN(64, BigInt(parts.lo.toString()));
        return ((hi << 64n) | lo).toString();
      }
      default:
        // Non-numeric returns (addresses, maps, void markers) are surfaced as
        // base64 XDR so the client can decode them with the SDK if it needs to.
        return Buffer.from(retval.toXdr()).toString('base64');
    }
  } catch {
    return '';
  }
}

/**
 * Simulate a stream action and return an unsigned, footprint-annotated
 * transaction ready for a browser wallet to sign.
 *
 * The returned XDR is produced by `rpc.assembleTransaction`, which applies the
 * simulated ledger footprint, resource limits and resource fee to the
 * transaction. Because it is built from the sender's *real* account, the
 * sequence number is the one current at simulation time — wallets should submit
 * promptly, and the API rejects the simulation if the client waits for the
 * validity window to lapse.
 */
export async function simulateStreamAction(
  action: StreamAction,
  senderPublicKey: string,
  params: SimulateActionParams = {},
): Promise<StreamSimulationResult> {
  const contractId = getContractId();
  if (!contractId) {
    throw new ApiError(503, 'contract_not_configured', 'Stream contract is not configured');
  }

  const sender = toAddress(senderPublicKey, 'senderPublicKey');
  const invocations = buildInvocations(action, sender, params);
  const contract = new Contract(contractId);

  // Use the sender's real account so the assembled XDR carries a valid
  // sequence number and is directly signable; fall back to the placeholder
  // when the account cannot be loaded (e.g. a not-yet-funded account).
  let sourceAccount: Account;
  try {
    sourceAccount = await withRpcRetry('getAccount', () =>
      withRpcTimeout('getAccount', () => executeRpc('getAccount', (server) => server.getAccount(senderPublicKey))),
    );
  } catch (err) {
    logger.warn(
      `[SorobanService] simulateStreamAction: getAccount(${senderPublicKey}) failed, using placeholder source`,
      err,
    );
    sourceAccount = new Account(SIMULATION_PLACEHOLDER_ACCOUNT, '0');
  }

  const builder = new TransactionBuilder(sourceAccount, {
    fee: SIMULATION_FEE,
    networkPassphrase:
      process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
  });

  for (const invocation of invocations) {
    builder.addOperation(contract.call(invocation.method, ...invocation.args));
  }

  const tx = builder.setTimeout(TX_TIMEOUT_SECONDS).build();

  const simulation = await withRpcRetry('simulateTransaction', () =>
    withRpcTimeout('simulateTransaction', () => executeRpc('simulateTransaction', (server) => server.simulateTransaction(tx))),
  );

  if (rpc.Api.isSimulationError(simulation)) {
    throw toSimulationApiError(
      typeof simulation.error === 'string' ? simulation.error : JSON.stringify(simulation.error),
      action,
    );
  }

  const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  const { cpuInstructions, memoryBytes } = readResourceFootprint(success.transactionData);

  const assembled = rpc.assembleTransaction(tx, success).build();

  return {
    // `Transaction.toXDR()` returns base64, which is what wallets expect.
    unsignedXdr: assembled.toXDR(),
    minResourceFee: success.minResourceFee,
    recommendedFee: applyFeeBuffer(success.minResourceFee),
    cpuInstructions,
    memoryBytes,
    expiresAtLedger: success.latestLedger + SIMULATION_VALIDITY_LEDGERS,
    simulatedReturn: decodeSimulatedReturn(success),
  };
}
