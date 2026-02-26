import type { WalletSession } from "@/lib/wallet";

const CONTRACT_ID =
  process.env.NEXT_PUBLIC_STREAM_CONTRACT_ID ?? "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

const MOCK_DELAY_MS = 1400;

export interface CreateStreamParams {
  recipient: string;
  tokenAddress: string;
  amount: bigint;
  durationSeconds: bigint;
}

export interface TopUpParams {
  streamId: bigint;
  amount: bigint;
}

export interface CancelParams {
  streamId: bigint;
}

export interface WithdrawParams {
  streamId: bigint;
}

export interface SorobanResult {
  success: true;
  txHash: string;
}

export class SorobanCallError extends Error {
  constructor(
    message: string,
    public readonly code?:
      | "InvalidAmount"
      | "StreamNotFound"
      | "Unauthorized"
      | "StreamInactive"
      | "AlreadyInitialized"
      | "NotAdmin"
      | "InvalidFeeRate"
      | "NotInitialized"
      | "WalletRejected"
      | "NetworkError"
      | "Unknown",
  ) {
    super(message);
    this.name = "SorobanCallError";
  }
}

type DurationUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

const SECONDS_PER_UNIT: Record<DurationUnit, bigint> = {
  seconds: BigInt(1),
  minutes: BigInt(60),
  hours:   BigInt(3600),
  days:    BigInt(86400),
  weeks:   BigInt(604800),
  months:  BigInt(2592000),
};

export function toDurationSeconds(value: string, unit: DurationUnit): bigint {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed <= 0) {
    throw new SorobanCallError("Duration must be a positive number.", "InvalidAmount");
  }
  return BigInt(Math.round(parsed)) * SECONDS_PER_UNIT[unit];
}

export function toBaseUnits(value: string, decimals = 7): bigint {
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed <= 0) {
    throw new SorobanCallError("Amount must be a positive number.", "InvalidAmount");
  }
  return BigInt(Math.round(parsed * 10 ** decimals));
}

export const TOKEN_ADDRESSES: Record<string, string> = {
  USDC: process.env.NEXT_PUBLIC_USDC_ADDRESS  ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  XLM:  process.env.NEXT_PUBLIC_XLM_ADDRESS   ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN",
  EURC: process.env.NEXT_PUBLIC_EURC_ADDRESS  ?? "CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY",
};

export function getTokenAddress(symbol: string): string {
  const address = TOKEN_ADDRESSES[symbol.toUpperCase()];
  if (!address) {
    throw new SorobanCallError(`Unsupported token: ${symbol}`, "Unknown");
  }
  return address;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockTxHash(): string {
  return Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

async function mockCall(label: string): Promise<SorobanResult> {
  console.info(`[soroban:mock] ${label}`);
  await wait(MOCK_DELAY_MS);
  return { success: true, txHash: mockTxHash() };
}

async function freighterCall(
  publicKey: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
): Promise<SorobanResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import("@stellar/stellar-sdk");
  const { Contract, TransactionBuilder, BASE_FEE } = sdk;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc: any = sdk.rpc ?? sdk.SorobanRpc;

  const { signTransaction } = await import("@stellar/freighter-api");

  const server = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });
  const account = await server.getAccount(publicKey);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api?.isSimulationError?.(simResult) ?? simResult?.error) {
    throw new SorobanCallError(`Simulation failed: ${simResult.error}`, "NetworkError");
  }

  const preparedTx = (rpc.assembleTransaction ?? sdk.assembleTransaction)(tx, simResult).build();

  const { signedTxXdr, error: signError } = await signTransaction(
    preparedTx.toXDR(),
    { networkPassphrase: NETWORK_PASSPHRASE },
  );

  if (signError) {
    const msg = typeof signError === "string" ? signError : (signError as Error).message;
    if (/reject|cancel|denied/i.test(msg)) {
      throw new SorobanCallError("Transaction was rejected in wallet.", "WalletRejected");
    }
    throw new SorobanCallError(msg, "Unknown");
  }

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sendResult = await server.sendTransaction(signedTx);

  if (sendResult.status === "ERROR") {
    throw new SorobanCallError(
      `Transaction failed: ${sendResult.errorResult?.toXDR?.("base64") ?? "unknown error"}`,
      "NetworkError",
    );
  }

  const txHash = sendResult.hash;
  const SUCCESS = rpc.Api?.GetTransactionStatus?.SUCCESS ?? "SUCCESS";
  const FAILED  = rpc.Api?.GetTransactionStatus?.FAILED  ?? "FAILED";

  for (let i = 0; i < 20; i++) {
    await wait(1000);
    const status = await server.getTransaction(txHash);
    if (status.status === SUCCESS) return { success: true, txHash };
    if (status.status === FAILED) {
      throw new SorobanCallError("Transaction failed on-chain.", "NetworkError");
    }
  }

  throw new SorobanCallError("Transaction confirmation timed out.", "NetworkError");
}

export function toSorobanErrorMessage(error: unknown): string {
  if (error instanceof SorobanCallError) return error.message;
  if (error instanceof Error) {
    const msg = error.message;
    if (/reject|cancel|denied/i.test(msg)) return "Transaction was rejected in your wallet.";
    if (/timeout/i.test(msg)) return "Transaction timed out. The network may be congested — please try again.";
    if (/insufficient/i.test(msg)) return "Insufficient balance to complete this transaction.";
    if (/simulation/i.test(msg)) return "Contract simulation failed. Check your inputs and try again.";
    return msg;
  }
  return "An unexpected error occurred. Please try again.";
}

export async function createStream(
  session: WalletSession,
  params: CreateStreamParams,
): Promise<SorobanResult> {
  if (session.mocked) {
    return mockCall(`create_stream recipient=${params.recipient} amount=${params.amount} duration=${params.durationSeconds}s`);
  }
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "create_stream", [
    new Address(session.publicKey).toScVal(),
    new Address(params.recipient).toScVal(),
    new Address(params.tokenAddress).toScVal(),
    nativeToScVal(params.amount, { type: "i128" }),
    nativeToScVal(params.durationSeconds, { type: "u64" }),
  ]);
}

export async function topUpStream(
  session: WalletSession,
  params: TopUpParams,
): Promise<SorobanResult> {
  if (session.mocked) {
    return mockCall(`top_up_stream stream_id=${params.streamId} amount=${params.amount}`);
  }
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "top_up_stream", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
    nativeToScVal(params.amount, { type: "i128" }),
  ]);
}

export async function cancelStream(
  session: WalletSession,
  params: CancelParams,
): Promise<SorobanResult> {
  if (session.mocked) {
    return mockCall(`cancel_stream stream_id=${params.streamId}`);
  }
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "cancel_stream", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
  ]);
}

export async function withdrawFromStream(
  session: WalletSession,
  params: WithdrawParams,
): Promise<SorobanResult> {
  if (session.mocked) {
    return mockCall(`withdraw stream_id=${params.streamId}`);
  }
  const { Address, nativeToScVal } = await import("@stellar/stellar-sdk");
  return freighterCall(session.publicKey, "withdraw", [
    new Address(session.publicKey).toScVal(),
    nativeToScVal(params.streamId, { type: "u64" }),
  ]);
}
