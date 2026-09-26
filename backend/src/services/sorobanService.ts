import { rpc, xdr, StrKey, Contract, nativeToScVal, Keypair, TransactionBuilder, Networks, Account, Address } from '@stellar/stellar-sdk';
import logger from '../logger.js';
import { ApiError } from '../lib/api-error.js';
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

export async function submitContractCall(method: string, args: xdr.ScVal[], senderSecret: string): Promise<string> {
  const contractId = getContractId();
  if (!contractId) throw new Error('CONTRACT_ID not set');

  const keypair = Keypair.fromSecret(senderSecret);
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
 * Latest ledger sequence known to the network, or 0 when it cannot be resolved.
 *
 * Feeds the `flowfi_indexer_network_ledger` gauge so `flowfi_indexer_lag_ledgers`
 * has a denominator even between indexer poll cycles.
 */
export async function getLatestLedger(): Promise<number> {
  try {
    const response = await withRpcRetry('getLatestLedger', () =>
      withRpcTimeout('getLatestLedger', () => getServer().getLatestLedger()),
    );
    return Number(response.sequence);
  } catch (err) {
    logger.warn('[SorobanService] getLatestLedger failed:', err);
    return 0;
  }
}

export async function getStreamFromChain(streamId: number): Promise<ChainStream | null> {
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
 * Cancels a stream on-chain.
 * @param streamId - The on-chain stream ID
 * @param senderSecret - The sender's private key used for cryptographic authorization.
 *   This should be the secret key of the stream's sender wallet, NOT the keeper key.
 *   Using the keeper key here defeats the purpose of per-action authorization.
 * @returns Transaction hash of the cancellation transaction
 */
export async function cancelStream(streamId: bigint, senderSecret: string): Promise<string> {
  return submitContractCall('cancel_stream', [
    nativeToScVal(streamId, { type: 'u64' }),
  ], senderSecret);
}

export async function topUpStream(streamId: bigint, amount: bigint, callerAddress: string): Promise<string> {
  const keeperSecret = getKeeperSecret();
  if (!keeperSecret) throw new Error('KEEPER_SECRET_KEY not configured');
  return submitContractCall('top_up_stream', [
    nativeToScVal(streamId, { type: 'u64' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(callerAddress, { type: 'address' }),
  ], keeperSecret);
}

/** Returns true when the DB record is older than STALE_THRESHOLD_MS. */
export function isStale(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() > STALE_THRESHOLD_MS;
}

export interface PauseResumeResult {
  txHash: string;
}

/**
 * Pause a stream. Calls the Soroban contract's pause_stream function.
 * Note: This is a read-only simulation to verify the operation would succeed.
 * The actual pause transaction must be signed by the sender and submitted by the frontend.
 */
export async function pauseStream(
  senderAddress: string,
  streamId: bigint
): Promise<PauseResumeResult> {
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

    // Return a mock txHash for now - in production this would be the actual transaction hash
    // The real transaction would be signed by the frontend and submitted separately
    return {
      txHash: 'simulated-pause-' + streamId,
    };
  } catch (err) {
    logger.error(`[SorobanService] pauseStream(${streamId}) failed:`, err);
    throw new Error(`Failed to pause stream: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Resume a paused stream. Calls the Soroban contract's resume_stream function.
 * Note: This is a read-only simulation to verify the operation would succeed.
 * The actual resume transaction must be signed by the sender and submitted by the frontend.
 */
export async function resumeStream(
  senderAddress: string,
  streamId: bigint
): Promise<PauseResumeResult> {
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

    // Return a mock txHash for now - in production this would be the actual transaction hash
    return {
      txHash: 'simulated-resume-' + streamId,
    };
  } catch (err) {
    logger.error(`[SorobanService] resumeStream(${streamId}) failed:`, err);
    throw new Error(`Failed to resume stream: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Withdraw from a stream. Calls the Soroban contract's withdraw function.
 * Note: This simulates the contract call and returns a placeholder tx hash,
 * matching the current pause/resume backend pattern.
 */
export async function withdraw(
  streamId: bigint,
  recipientAddress: string,
): Promise<PauseResumeResult> {
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

    return {
      txHash: 'simulated-withdraw-' + streamId,
    };
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

  return new ApiError(400, message, 'simulation_failed', {
    action,
    reason: rawError,
    ...(code !== null ? { contractErrorCode: code } : {}),
    ...(known ? { hint: known.hint } : {}),
  });
}

function toStreamId(raw: string | undefined, field: string): bigint {
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError(400, `${field} is required`, 'invalid_params');
  }
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(400, `${field} must be a non-negative integer string`, 'invalid_params');
  }
  return BigInt(raw);
}

function toPositiveI128(raw: string | undefined, field: string): bigint {
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError(400, `${field} is required`, 'invalid_params');
  }
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(400, `${field} must be a positive integer string`, 'invalid_params');
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new ApiError(400, `${field} must be greater than zero`, 'invalid_params');
  }
  return value;
}

function toAddress(raw: string | undefined, field: string): Address {
  if (!raw) {
    throw new ApiError(400, `${field} is required`, 'invalid_params');
  }
  try {
    return new Address(raw);
  } catch {
    throw new ApiError(400, `${field} is not a valid Stellar address`, 'invalid_params');
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
          'params.duration must be a positive integer (seconds)',
          'invalid_params',
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
          'params.streamIds is required for batch_withdraw',
          'invalid_params',
        );
      }
      if (ids.length > MAX_BATCH_WITHDRAW) {
        throw new ApiError(
          400,
          `batch_withdraw accepts at most ${MAX_BATCH_WITHDRAW} streams per transaction`,
          'invalid_params',
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
      throw new ApiError(400, `Unsupported action: ${String(exhaustive)}`, 'invalid_params');
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
    const resources = data.resources();
    return {
      cpuInstructions: Number(resources.instructions()),
      memoryBytes: Number(resources.writeBytes()),
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
    switch (retval.switch().value) {
      case xdr.ScValType.scvI128().value:
        return decodeI128(retval);
      case xdr.ScValType.scvU64().value:
        return retval.u64().toString();
      case xdr.ScValType.scvU32().value:
        return retval.u32().toString();
      case xdr.ScValType.scvI64().value:
        return retval.i64().toString();
      case xdr.ScValType.scvU128().value: {
        const parts = retval.u128();
        const hi = BigInt.asUintN(64, BigInt(parts.hi().toString()));
        const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
        return ((hi << 64n) | lo).toString();
      }
      default:
        // Non-numeric returns (addresses, maps, void markers) are surfaced as
        // base64 XDR so the client can decode them with the SDK if it needs to.
        return Buffer.from(retval.toXDR()).toString('base64');
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
    throw new ApiError(503, 'Stream contract is not configured', 'contract_not_configured');
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
      withRpcTimeout('getAccount', () => getServer().getAccount(senderPublicKey)),
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
    withRpcTimeout('simulateTransaction', () => getServer().simulateTransaction(tx)),
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
