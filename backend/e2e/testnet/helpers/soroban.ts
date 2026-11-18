import {
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';
import { testnetConfig } from './config.js';

export const server = new rpc.Server(testnetConfig.rpcUrl, {
  allowHttp: testnetConfig.rpcUrl.startsWith('http://'),
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry `fn` with exponential backoff; used for flaky public endpoints. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { attempts = 5, baseMs = 1_000 } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i);
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Poll `check` until it returns a non-undefined value or the timeout elapses. */
export async function waitFor<T>(
  label: string,
  check: () => Promise<T | undefined>,
  { timeoutMs, intervalMs = 2_000 }: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Fund a fresh account via Friendbot and return its keypair. */
export async function createFundedAccount(): Promise<Keypair> {
  const kp = Keypair.random();
  await withRetry('Friendbot funding', async () => {
    const res = await fetch(
      `${testnetConfig.friendbotUrl}?addr=${encodeURIComponent(kp.publicKey())}`,
    );
    // Friendbot returns 400 "createAccountAlreadyExist" on a retry after a
    // successful-but-timed-out first attempt; treat that as success.
    if (!res.ok) {
      const body = await res.text();
      if (!body.includes('createAccountAlreadyExist')) {
        throw new Error(`Friendbot HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
    }
  });
  // Wait until the RPC node can see the new account (ledger ingestion lag).
  await waitFor(
    `account ${kp.publicKey()} visible on RPC`,
    async () => {
      try {
        return await server.getAccount(kp.publicKey());
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 60_000 },
  );
  return kp;
}

/** Stellar Asset Contract address for native XLM on the configured network. */
export function nativeTokenContractId(): string {
  return Asset.native().contractId(testnetConfig.networkPassphrase);
}

export interface InvokeResult {
  hash: string;
  ledger: number;
  returnValue: unknown;
}

/**
 * Build, simulate, sign, submit and await a Soroban contract invocation.
 * Throws with the full result XDR on simulation or execution failure so the
 * CI log pinpoints protocol/RPC regressions.
 */
export async function invokeContract(
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<InvokeResult> {
  const source = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: testnetConfig.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  // prepareTransaction simulates, applies the footprint/resource fee and auth.
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new Error(
      `${method}: sendTransaction returned ${sent.status}: ${sent.errorResult?.toXDR('base64') ?? 'no errorResult'}`,
    );
  }

  const final = await waitFor(
    `${method} tx ${sent.hash} to finalize`,
    async () => {
      const res = await server.getTransaction(sent.hash);
      return res.status === rpc.Api.GetTransactionStatus.NOT_FOUND ? undefined : res;
    },
    { timeoutMs: testnetConfig.txTimeoutMs, intervalMs: 1_500 },
  );

  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `${method}: transaction ${sent.hash} ${final.status}: ${final.resultXdr?.toXDR('base64') ?? ''}`,
    );
  }

  return {
    hash: sent.hash,
    ledger: final.ledger,
    returnValue: final.returnValue ? scValToNative(final.returnValue) : undefined,
  };
}

/** Read-only contract call via simulation (no submission, no fees). */
export async function simulateRead(
  source: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: testnetConfig.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}
