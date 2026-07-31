import { rpc, xdr, StrKey, Contract, nativeToScVal, Keypair, TransactionBuilder, Networks, Account } from '@stellar/stellar-sdk';
import logger from '../logger.js';

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
    return await Promise.race([fn(controller.signal), timedOut]);
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
      if (attempt > maxRetries || !isTransientRpcError(err)) throw err;
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
 * Throw-away source account used when building simulation-only transactions.
 * Any valid Ed25519 public key works here; the account never needs to exist on-chain
 * because simulation transactions are never submitted.
 */
const SIMULATION_PLACEHOLDER_ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

let _server: rpc.Server | null = null;

function getServer(): rpc.Server {
  if (!_server) {
    _server = new rpc.Server(RPC_URL, { allowHttp: true });
  }
  return _server;
}

/**
 * Lightweight connectivity check used by the /health endpoint.
 * Calls the RPC server's getHealth() with a bounded timeout so a slow or
 * unreachable Soroban RPC endpoint can't hang the health check.
 */
export async function checkRpcHealth(timeoutMs = 3_000): Promise<boolean> {
  try {
    await withRpcTimeout('soroban rpc health check', () => getServer().getHealth(), timeoutMs);
    return true;
  } catch {
    return false;
  }
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
  const parts = val.i128();
  const hi = BigInt.asIntN(64, BigInt(parts.hi().toString()));
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  return ((hi << 64n) | lo).toString();
}

export function decodeAddress(val: xdr.ScVal): string {
  const addr = val.address();
  if (addr.switch().value === xdr.ScAddressType.scAddressTypeAccount().value) {
    return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
  }
  const hash = addr.contractId();
  return StrKey.encodeContract(Buffer.from(hash as unknown as Uint8Array));
}

function decodeMap(val: xdr.ScVal): Record<string, xdr.ScVal> {
  const result: Record<string, xdr.ScVal> = {};
  for (const entry of val.map() ?? []) {
    result[entry.key().sym().toString()] = entry.val();
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
    withRpcTimeout('simulateTransaction', () => getServer().simulateTransaction(tx)),
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
  const account = await withRpcTimeout('getAccount', () => getServer().getAccount(keypair.publicKey()));

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
    withRpcTimeout('simulateTransaction', () => getServer().simulateTransaction(tx)),
  );
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // Assemble transaction with simulation results
  const assembledTx = rpc.assembleTransaction(tx, simulation).build();
  assembledTx.sign(keypair);

  const response = await withRpcTimeout('sendTransaction', () => getServer().sendTransaction(assembledTx));

  if (response.status === 'ERROR') {
    throw new Error(`Transaction failed: ${JSON.stringify(response.errorResult)}`);
  }

  return response.hash;
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
      isActiveVal.switch().value === xdr.ScValType.scvBool().value &&
      isActiveVal.b() === true;

    return {
      streamId,
      sender: decodeAddress(fields['sender']!),
      recipient: decodeAddress(fields['recipient']!),
      tokenAddress: decodeAddress(fields['token_address']!),
      ratePerSecond: decodeI128(fields['rate_per_second']!),
      depositedAmount: decodeI128(fields['deposited_amount']!),
      withdrawnAmount: decodeI128(fields['withdrawn_amount']!),
      startTime: Number(fields['start_time']!.u64().toString()),
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
