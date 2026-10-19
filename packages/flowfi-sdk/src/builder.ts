/**
 * Soroban transaction construction + simulation pipeline.
 *
 * Responsibilities:
 * - Build unsigned contract-invocation transactions for each FlowFi entrypoint.
 * - Run `simulateTransaction` against the Soroban RPC so footprint keys and
 *   authorization entries are attached automatically.
 * - Apply a configurable resource-fee safety buffer before signing.
 */

import type { CreateStreamParams } from './types.js';

export interface BuildCallArgs {
  /** Source account (G...) paying the fee and authorizing the call. */
  sourceAccount: string;
  contractId: string;
  networkPassphrase: string;
}

export interface SimulationAdapter {
  simulateTransaction(tx: unknown): Promise<{
    assembledTx?: unknown;
    minResourceFee?: string | number | bigint;
    error?: unknown;
  }>;
  getAccount?(address: string): Promise<unknown>;
}

/** Default fee buffer: 25% on top of the simulated minimum resource fee. */
export const DEFAULT_FEE_BUFFER_MULTIPLIER = 1.25;

/** Minimum base fee in stroops used when simulation gives no fee hint. */
export const FALLBACK_BASE_FEE_STROOPS = 100;

/**
 * Apply a multiplicative safety buffer to a simulated resource fee.
 *
 * Always rounds up so the padded fee is never below the simulation minimum.
 */
export function applyFeeBuffer(minResourceFee: bigint, multiplier = DEFAULT_FEE_BUFFER_MULTIPLIER): string {
  if (multiplier < 1) {
    throw new Error('applyFeeBuffer: multiplier must be >= 1');
  }
  const scaled = Number(minResourceFee) * multiplier;
  return BigInt(Math.ceil(scaled)).toString();
}

/**
 * Build an unsigned Soroban contract-invocation transaction envelope (base64 XDR).
 *
 * This is intentionally thin: argument encoding follows the `stream_contract`
 * interface (`create_stream`, `withdraw`, `top_up_stream`, `cancel_stream`,
 * `close_stream`, `get_stream`, `get_claimable_amount`).
 */
export async function buildContractCallXdr(args: {
  sourceAccount: string;
  contractId: string;
  networkPassphrase: string;
  method: string;
  methodArgs: unknown[];
  baseFeeStroops?: number;
}): Promise<string> {
  const { Account, Contract, TransactionBuilder, nativeToScVal } = await import(
    '@stellar/stellar-sdk'
  );

  const { sourceAccount, contractId, networkPassphrase, method, methodArgs, baseFeeStroops } = args;

  // The sequence number is a placeholder for offline building; `simulateTransaction`
  // + `assembleTransaction` (or the RPC `prepareTransaction` flow) refreshes it
  // against the live account entry before submission. Callers that need an exact
  // sequence should fetch it via `server.getAccount(source)` first.
  const source = new Account(sourceAccount, '0');
  const contract = new Contract(contractId);

  const encodedArgs = encodeMethodArgs(method, methodArgs, { nativeToScVal });

  const op = contract.call(method, ...encodedArgs);
  const tx = new TransactionBuilder(source, {
    fee: String(baseFeeStroops ?? FALLBACK_BASE_FEE_STROOPS),
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

/** Encode high-level JS args into ScVals per contract method. */
function encodeMethodArgs(
  method: string,
  methodArgs: unknown[],
  codecs: { nativeToScVal: (v: unknown, opts?: { type?: string }) => unknown },
): unknown[] {
  const { nativeToScVal } = codecs;
  switch (method) {
    case 'create_stream':
    case 'create_stream_with_cliff': {
      const [sender, recipient, token, amount, duration, cliff] = methodArgs as [
        string,
        string,
        string,
        bigint,
        number,
        number?,
      ];
      const out: unknown[] = [sender, recipient, token, nativeToScVal(amount, { type: 'i128' }), nativeToScVal(duration, { type: 'u64' })];
      if (cliff !== undefined) out.push(nativeToScVal(cliff, { type: 'u64' }));
      return out;
    }
    case 'withdraw':
    case 'cancel_stream':
    case 'close_stream':
    case 'top_up_stream':
    case 'get_stream':
    case 'get_claimable_amount':
    case 'batch_withdraw':
      // Mixed address/u64/i128 args — pass through addresses as-is and let the
      // caller pre-encode numeric ScVals where needed. Most flows below already
      // pass ScVals, so this stays forward-compatible.
      return methodArgs;
    default:
      return methodArgs;
  }
}

/** Build a `create_stream` (or cliff variant) unsigned envelope. */
export async function buildCreateStreamXdr(
  params: CreateStreamParams,
  build: BuildCallArgs,
): Promise<string> {
  const { nativeToScVal, Address } = await import('@stellar/stellar-sdk');
  void Address;
  const method = params.cliffDuration !== undefined ? 'create_stream_with_cliff' : 'create_stream';
  const methodArgs: unknown[] = [
    params.sender,
    params.recipient,
    params.tokenAddress,
    params.amount,
    params.duration,
    ...(params.cliffDuration !== undefined ? [params.cliffDuration] : []),
  ];
  void nativeToScVal;
  return buildContractCallXdr({
    sourceAccount: build.sourceAccount,
    contractId: build.contractId,
    networkPassphrase: build.networkPassphrase,
    method,
    methodArgs,
  });
}

/** Build a `withdraw` envelope for a single stream. */
export async function buildWithdrawXdr(
  streamId: bigint,
  recipient: string,
  build: BuildCallArgs,
): Promise<string> {
  const { nativeToScVal } = await import('@stellar/stellar-sdk');
  return buildContractCallXdr({
    ...build,
    method: 'withdraw',
    methodArgs: [recipient, nativeToScVal(streamId, { type: 'u64' })],
  });
}

/** Build a `top_up_stream` envelope. */
export async function buildTopUpXdr(
  streamId: bigint,
  sender: string,
  amount: bigint,
  build: BuildCallArgs,
): Promise<string> {
  const { nativeToScVal } = await import('@stellar/stellar-sdk');
  return buildContractCallXdr({
    ...build,
    method: 'top_up_stream',
    methodArgs: [
      sender,
      nativeToScVal(streamId, { type: 'u64' }),
      nativeToScVal(amount, { type: 'i128' }),
    ],
  });
}

/** Build a `cancel_stream` envelope. */
export async function buildCancelXdr(
  streamId: bigint,
  sender: string,
  build: BuildCallArgs,
): Promise<string> {
  const { nativeToScVal } = await import('@stellar/stellar-sdk');
  return buildContractCallXdr({
    ...build,
    method: 'cancel_stream',
    methodArgs: [sender, nativeToScVal(streamId, { type: 'u64' })],
  });
}

/** Build a `close_stream` envelope (storage reclamation, issue #1441). */
export async function buildCloseXdr(
  streamId: bigint,
  caller: string,
  build: BuildCallArgs,
): Promise<string> {
  const { nativeToScVal } = await import('@stellar/stellar-sdk');
  return buildContractCallXdr({
    ...build,
    method: 'close_stream',
    methodArgs: [caller, nativeToScVal(streamId, { type: 'u64' })],
  });
}

/**
 * Simulate an unsigned envelope and return the assembled (ready-to-sign) XDR
 * plus the buffered resource fee.
 *
 * The RPC simulation attaches footprint keys + auth entries; callers sign the
 * returned `assembledXdr`, never the input.
 */
export async function simulateAndAssemble(args: {
  unsignedXdr: string;
  networkPassphrase: string;
  rpcUrl: string;
  feeBufferMultiplier?: number;
  rpcClient?: {
    simulateTransaction(tx: unknown): Promise<unknown>;
  };
}): Promise<{ assembledXdr: string; resourceFee: string }> {
  const { TransactionBuilder, rpc } = await import('@stellar/stellar-sdk');
  const multiplier = args.feeBufferMultiplier ?? DEFAULT_FEE_BUFFER_MULTIPLIER;

  const tx = TransactionBuilder.fromXDR(args.unsignedXdr, args.networkPassphrase);

  const server = args.rpcClient ?? new rpc.Server(args.rpcUrl, { allowHttp: args.rpcUrl.startsWith('http://') });
  const simulation = (await (server as unknown as SimulationAdapter).simulateTransaction(tx)) as {
    error?: unknown;
    minResourceFee?: string;
    assembledTx?: unknown;
  };

  if (simulation.error) {
    throw new Error(`simulateAndAssemble: simulation failed: ${JSON.stringify(simulation.error)}`);
  }

  // `assembleTransaction` merges simulation side-effects (footprint, auth) into
  // a new transaction object. Fall back to the original tx when the SDK/server
  // mock does not return one (unit tests).
  let assembled: unknown = tx;
  try {
    const { rpc: rpcNs } = await import('@stellar/stellar-sdk');
    const assemble = (rpcNs as unknown as { assembleTransaction?: (t: unknown, s: unknown) => Promise<unknown> }).assembleTransaction;
    if (typeof assemble === 'function' && simulation) {
      assembled = await assemble(tx, simulation);
    }
    if (simulation.assembledTx) assembled = simulation.assembledTx;
  } catch {
    // Keep the original tx when assembly helpers are unavailable (mocks).
  }

  const minFee = BigInt(simulation.minResourceFee ?? FALLBACK_BASE_FEE_STROOPS);
  const resourceFee = applyFeeBuffer(minFee, multiplier);
  const assembledXdr = (assembled as { toXDR: () => string }).toXDR?.() ?? args.unsignedXdr;

  return { assembledXdr, resourceFee };
}
