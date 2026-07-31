import { describe, it, expect, vi, beforeEach } from "vitest";

const getAccount = vi.fn().mockResolvedValue({});
const simulateTransaction = vi.fn();

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
      return {};
    }
  }
  return {
    Address,
    Contract,
    TransactionBuilder,
    BASE_FEE: "100",
    scValToNative: vi.fn(),
    rpc: {
      Server: vi.fn().mockImplementation(() => ({
        getAccount,
        simulateTransaction,
      })),
      Api: {
        isSimulationError: (result: { error?: unknown }) => Boolean(result?.error),
      },
    },
  };
});

import { fetchTokenBalance, SorobanCallError } from "./soroban";

describe("soroban RPC error handling", () => {
  beforeEach(() => {
    simulateTransaction.mockReset();
    getAccount.mockResolvedValue({});
  });

  it("throws a ContractNotFound error when the RPC response indicates a missing contract", async () => {
    simulateTransaction.mockResolvedValue({
      error: "HostError: Error(Storage, MissingValue): trying to get non-existing contract instance",
    });

    await expect(fetchTokenBalance("GABC", "USDC")).rejects.toMatchObject({
      name: "SorobanCallError",
      code: "ContractNotFound",
    });

    try {
      await fetchTokenBalance("GABC", "USDC");
      throw new Error("expected fetchTokenBalance to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SorobanCallError);
      expect((error as SorobanCallError).message).toMatch(/no contract is deployed/i);
    }
  });

  it("throws a generic NetworkError for other simulation failures", async () => {
    simulateTransaction.mockResolvedValue({
      error: "some unrelated simulation failure",
    });

    await expect(fetchTokenBalance("GABC", "USDC")).rejects.toMatchObject({
      name: "SorobanCallError",
      code: "NetworkError",
    });
  });
});
