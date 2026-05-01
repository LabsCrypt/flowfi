import { rpc, xdr, StrKey, Contract, nativeToScVal, Keypair, TransactionBuilder, Account, Networks } from '@stellar/stellar-sdk';
import logger from '../logger.js';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.STREAM_CONTRACT_ID ?? '';
const KEEPER_SECRET = process.env.KEEPER_SECRET_KEY ?? '';
/** DB data older than this is considered stale and triggers an RPC fallback. */
const STALE_THRESHOLD_MS = 30_000;

const server = new rpc.Server(RPC_URL, { allowHttp: true });

export interface ChainStream {
  streamId: number;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  isActive: boolean;
}

function decodeI128(val: xdr.ScVal): string {
  const parts = val.i128();
  const hi = BigInt.asIntN(64, BigInt(parts.hi().toString()));
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  return ((hi << 64n) | lo).toString();
}

function decodeAddress(val: xdr.ScVal): string {
  const addr = val.address();
  if (addr.switch().value === xdr.ScAddressType.scAddressTypeAccount().value) {
    return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
  }
  return StrKey.encodeContract(Buffer.from(addr.contractId() as any));
}

function decodeMap(val: xdr.ScVal): Record<string, xdr.ScVal> {
  const result: Record<string, xdr.ScVal> = {};
  for (const entry of val.map() ?? []) {
    result[entry.key().sym().toString()] = entry.val();
  }
  return result;
}

async function simulateContractCall(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const contract = new Contract(CONTRACT_ID);

  const op = contract.call(method, ...args);

  const { TransactionBuilder, Account, Networks } = await import('@stellar/stellar-sdk');

  const tx = new TransactionBuilder(
    new Account(
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      '0'
    ),
    {
      fee: '100',
      networkPassphrase:
        process.env.STELLAR_NETWORK === 'mainnet'
          ? Networks.PUBLIC
          : Networks.TESTNET,
    }
  )
    .addOperation(op)
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }

  const simSuccess = result as rpc.Api.SimulateTransactionSuccessResponse;
  return simSuccess.result!.retval;
}

async function submitContractCall(method: string, args: xdr.ScVal[], senderSecret: string): Promise<string> {
  if (!CONTRACT_ID) throw new Error('CONTRACT_ID not set');

  const keypair = Keypair.fromSecret(senderSecret);
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(keypair.publicKey());

  const op = contract.call(method, ...args);

  const tx = new TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase:
      process.env.STELLAR_NETWORK === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  // Simulate first to get foot print and resource info
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  // Assemble transaction with simulation results
  const assembledTx = rpc.assembleTransaction(tx, simulation).build();
  assembledTx.sign(keypair);

  const response = await server.sendTransaction(assembledTx);

  if (response.status === 'ERROR') {
    throw new Error(`Transaction failed: ${JSON.stringify(response.errorResult)}`);
  }

  return response.hash;
}

export async function getStreamFromChain(streamId: number): Promise<ChainStream | null> {
  if (!CONTRACT_ID) return null;

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

export async function getClaimableFromChain(streamId: number): Promise<string | null> {
  if (!CONTRACT_ID) return null;

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

export async function cancelStream(streamId: number, senderSecret: string): Promise<string> {
  return submitContractCall('cancel_stream', [
    nativeToScVal(streamId, { type: 'u64' }),
  ], senderSecret);
}

export async function topUpStream(streamId: number, amount: bigint, callerAddress: string): Promise<string> {
  if (!KEEPER_SECRET) throw new Error('KEEPER_SECRET_KEY not configured');
  return submitContractCall('top_up_stream', [
    nativeToScVal(streamId, { type: 'u64' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(callerAddress, { type: 'address' }),
  ], KEEPER_SECRET);
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
  streamId: number
): Promise<PauseResumeResult> {
  if (!CONTRACT_ID) {
    throw new Error('Stream contract ID not configured');
  }

  try {
    const { Address } = await import('@stellar/stellar-sdk');
    
    const senderAddr = new Address(senderAddress);
    
    const retval = await simulateContractCall('pause_stream', [
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
  streamId: number
): Promise<PauseResumeResult> {
  if (!CONTRACT_ID) {
    throw new Error('Stream contract ID not configured');
  }

  try {
    const { Address } = await import('@stellar/stellar-sdk');
    
    const senderAddr = new Address(senderAddress);
    
    const retval = await simulateContractCall('resume_stream', [
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
  streamId: number,
  recipientAddress: string,
): Promise<PauseResumeResult> {
  if (!CONTRACT_ID) {
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
