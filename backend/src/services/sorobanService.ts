import { rpc, xdr, StrKey, Contract, Address, nativeToScVal } from '@stellar/stellar-sdk';
import logger from '../logger.js';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.STREAM_CONTRACT_ID ?? '';
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
  const tx = new (await import('@stellar/stellar-sdk')).TransactionBuilder(
    new (await import('@stellar/stellar-sdk')).Account('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', '0'),
    { fee: '100', networkPassphrase: process.env.STELLAR_NETWORK === 'mainnet'
        ? (await import('@stellar/stellar-sdk')).Networks.PUBLIC
        : (await import('@stellar/stellar-sdk')).Networks.TESTNET }
  ).addOperation(op).setTimeout(30).build();

  const result = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }
  const simSuccess = result as rpc.Api.SimulateTransactionSuccessResponse;
  return simSuccess.result!.retval;
}

export async function getStreamFromChain(streamId: number): Promise<ChainStream | null> {
  if (!CONTRACT_ID) return null;
  try {
    const retval = await simulateContractCall('get_stream', [
      nativeToScVal(streamId, { type: 'u64' }),
    ]);
    const fields = decodeMap(retval);
    return {
      streamId,
      sender: decodeAddress(fields['sender']!),
      recipient: decodeAddress(fields['recipient']!),
      tokenAddress: decodeAddress(fields['token_address']!),
      ratePerSecond: decodeI128(fields['rate_per_second']!),
      depositedAmount: decodeI128(fields['deposited_amount']!),
      withdrawnAmount: decodeI128(fields['withdrawn_amount']!),
      startTime: Number(fields['start_time']!.u64().toString()),
      isActive: fields['is_active']!.switch().value === xdr.ScValType.scvBool().value && fields['is_active']!.b() === true,
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

/** Returns true when the DB record is older than STALE_THRESHOLD_MS. */
export function isStale(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() > STALE_THRESHOLD_MS;
}
