/**
 * Soroban transaction confirmation polling (issue #1794).
 *
 * After the wallet signs a transaction, the client polls the RPC until the
 * transaction reaches a terminal state:
 *
 *  - success   → the transaction is confirmed and the tx hash is returned,
 *  - failure   → the transaction failed on-chain and the error is surfaced,
 *  - timeout   → the transaction never reaches a terminal state and the
 *                confirmation times out,
 *  - cancellation → the user rejected the transaction in the wallet.
 *
 * These are the states the create-stream UI reacts to, so they are pinned
 * down here with a deterministic fake RPC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getAccount,
  simulateTransaction,
  sendTransaction,
  getTransaction,
  signTransaction,
  assessMultisigRouting,
} = vi.hoisted(() => ({
  getAccount: vi.fn(),
  simulateTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  getTransaction: vi.fn(),
  signTransaction: vi.fn(),
  assessMultisigRouting: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", () => {
  class Address {
    constructor(private value: string) {}
    toScVal() {
      return this.value;
    }
  }
  class Contract {
    constructor(private address: string) {}
    call(method: string, ...args: unknown[]) {
      return { method, args, address: this.address };
    }
  }
  class TransactionBuilder {
    constructor() {}
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { toXDR: () => "unsigned-xdr" };
    }
    static fromXDR() {
      return { signed: true };
    }
  }
  return {
    Address,
    Contract,
    TransactionBuilder,
    BASE_FEE: "100",
    nativeToScVal: (value: unknown) => ({ value: String(value) }),
    rpc: {
      Server: vi.fn(() => ({
        getAccount,
        simulateTransaction,
        sendTransaction,
        getTransaction,
      })),
      Api: {
        isSimulationError: (result: { error?: unknown }) => Boolean(result?.error),
        GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" },
      },
      assembleTransaction: () => ({
        build: () => ({ toXDR: () => "assembled-xdr" }),
      }),
    },
  };
});

vi.mock("@stellar/freighter-api", () => ({
  signTransaction,
}));

vi.mock("@/lib/stellar-multisig", () => ({
  assessMultisigRouting,
}));

import { createStream, SorobanCallError } from "./soroban";
import type { WalletSession } from "./wallet";

const PUBLIC_KEY = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";
const RECIPIENT = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN";

const session: WalletSession = {
  walletId: "freighter",
  walletName: "Freighter",
  publicKey: PUBLIC_KEY,
  connectedAt: "2026-01-01T00:00:00.000Z",
  network: "testnet",
  mocked: false,
};

const params = {
  recipient: RECIPIENT,
  tokenAddress: TOKEN,
  amount: 1_000_000_000n,
  durationSeconds: 2_592_000n,
};

describe("createStream transaction confirmation polling (issue #1794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue({});
    simulateTransaction.mockResolvedValue({ result: { retval: {} } });
    sendTransaction.mockResolvedValue({ status: "PENDING", hash: "tx_hash_123" });
    signTransaction.mockResolvedValue({ signedTxXdr: "signed-xdr", error: null });
    assessMultisigRouting.mockResolvedValue({ needsProposal: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the tx hash once the transaction is confirmed", async () => {
    vi.useFakeTimers();
    getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS" });

    const pending = createStream(session, params);
    // Each poll happens one second after the previous one.
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual({
      success: true,
      txHash: "tx_hash_123",
    });

    // The client polls until the transaction reaches a terminal state.
    expect(getTransaction).toHaveBeenCalledTimes(3);
    expect(getTransaction).toHaveBeenCalledWith("tx_hash_123");
  });

  it("fails when the transaction failed on-chain", async () => {
    vi.useFakeTimers();
    getTransaction.mockResolvedValue({ status: "FAILED" });

    const pending = createStream(session, params);
    // Attach the rejection handler before the poll rejects the promise.
    const assertion = expect(pending).rejects.toMatchObject({
      name: "SorobanCallError",
      message: "Transaction failed on-chain.",
      code: "NetworkError",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("times out when the transaction is never confirmed", async () => {
    vi.useFakeTimers();
    getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    const pending = createStream(session, params);
    const assertion = expect(pending).rejects.toMatchObject({
      name: "SorobanCallError",
      message: "Transaction confirmation timed out.",
      code: "NetworkError",
    });

    // The confirmation loop polls 20 times, one second apart.
    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
    expect(getTransaction).toHaveBeenCalledTimes(20);
  });

  it("reports a wallet cancellation without polling", async () => {
    signTransaction.mockResolvedValue({
      signedTxXdr: "",
      error: "User rejected the request",
    });

    await expect(
      createStream(session, params),
    ).rejects.toMatchObject({
      name: "SorobanCallError",
      message: "Transaction was rejected in wallet.",
      code: "WalletRejected",
    });

    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("fails when the transaction could not be broadcast", async () => {
    sendTransaction.mockResolvedValue({
      status: "ERROR",
      errorResult: { toXDR: () => "base64-error" },
    });

    await expect(
      createStream(session, params),
    ).rejects.toMatchObject({
      name: "SorobanCallError",
      message: "Transaction failed: base64-error",
      code: "NetworkError",
    });
  });

  it("fails when the simulation reports an error", async () => {
    simulateTransaction.mockResolvedValue({ error: "simulation failed" });

    await expect(
      createStream(session, params),
    ).rejects.toBeInstanceOf(SorobanCallError);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("routes a partial multisig signature to the co-signing flow", async () => {
    assessMultisigRouting.mockResolvedValue({ needsProposal: true });

    await expect(
      createStream(session, params),
    ).rejects.toMatchObject({
      name: "MultisigRequiredError",
      signedXdr: "signed-xdr",
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
