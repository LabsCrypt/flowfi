/**
 * TokenStep regression tests (issue #1798).
 *
 * The token step renders the supported tokens and their avatars. Its
 * dependencies are the token metadata lookups:
 *
 *  - the token address registry (`TOKEN_ADDRESSES`) — a missing entry must
 *    degrade to the deterministic avatar fallback instead of crashing,
 *  - the token decimals lookup (`fetchTokenDecimals`) — a missing, malformed
 *    or unsupported decimals value must fall back to Stellar's 7 decimals,
 *  - the address resolver (`getTokenAddress`) — an unknown token must fail
 *    loudly with a `SorobanCallError`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { simulateTransaction, getAccount, scValToNative } = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  getAccount: vi.fn(),
  scValToNative: vi.fn((value: unknown) => (value as { value?: unknown })?.value),
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
    call(method: string) {
      return { method, address: this.address };
    }
  }
  class TransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { toXDR: () => "xdr" };
    }
  }
  return {
    Address,
    Contract,
    TransactionBuilder,
    BASE_FEE: "100",
    Keypair: { random: () => ({ publicKey: () => "GKEYPAIR" }) },
    scValToNative,
    rpc: {
      Server: vi.fn(() => ({ getAccount, simulateTransaction })),
      Api: {
        isSimulationError: (result: { error?: unknown }) => Boolean(result?.error),
      },
    },
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The token address registry is overridable per test so the "missing
// metadata" path can be exercised deterministically.
const tokenAddresses = vi.hoisted(() => ({
  current: {} as Record<string, string>,
}));

vi.mock("@/lib/soroban", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/soroban")>();
  return {
    ...actual,
    get TOKEN_ADDRESSES() {
      return tokenAddresses.current;
    },
  };
});

import { TokenStep } from "../TokenStep";
import { getTokenAddress, SorobanCallError } from "@/lib/soroban";
import {
  fetchTokenDecimals,
  getCachedTokenDecimals,
  clearTokenDecimalsCache,
  getDefaultTokenDecimals,
  getTokenDecimalsSync,
} from "@/utils/amount";

const FULL_REGISTRY = {
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN",
  EURC: "CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY",
} as const;

describe("TokenStep — rendering and selection (issue #1798)", () => {
  beforeEach(() => {
    tokenAddresses.current = { ...FULL_REGISTRY };
  });

  it("renders one radio per supported token inside a radiogroup", () => {
    render(<TokenStep value="" onChange={vi.fn()} />);

    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-labelledby", "token-group-label");
    expect(screen.getByText("Select Token")).toBeInTheDocument();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("USDC"),
      expect.stringContaining("XLM"),
      expect.stringContaining("EURC"),
    ]);
  });

  it("marks only the selected token as checked", () => {
    render(<TokenStep value="XLM" onChange={vi.fn()} />);

    const [usdc, xlm, eurtc] = screen.getAllByRole("radio");
    expect(usdc).toHaveAttribute("aria-checked", "false");
    expect(xlm).toHaveAttribute("aria-checked", "true");
    expect(eurtc).toHaveAttribute("aria-checked", "false");
  });

  it("reports the selected symbol to the parent", () => {
    const onChange = vi.fn();
    render(<TokenStep value="" onChange={onChange} />);

    fireEvent.click(screen.getAllByRole("radio")[2] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith("EURC");
  });

  it("renders the error contract and wires it to the radiogroup", () => {
    render(
      <TokenStep value="" onChange={vi.fn()} error="Please select a token" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Please select a token");
    expect(screen.getByRole("radiogroup")).toHaveAttribute(
      "aria-describedby",
      "token-error",
    );
  });

  it("does not reference an error id when there is no error", () => {
    render(<TokenStep value="" onChange={vi.fn()} />);

    expect(screen.getByRole("radiogroup")).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("TokenStep — missing token metadata (issue #1798)", () => {
  it("falls back to the avatar initials when no logo is available", () => {
    tokenAddresses.current = { ...FULL_REGISTRY };
    render(<TokenStep value="USDC" onChange={vi.fn()} />);

    // No <img> is rendered (no logo source), so the deterministic fallback
    // with the token initials is used instead.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("US")).toBeInTheDocument();
    expect(screen.getByText("XL")).toBeInTheDocument();
    expect(screen.getByText("EU")).toBeInTheDocument();
  });

  it("still renders the token when its contract address is missing", () => {
    // A registry without XLM: the address is unknown, but the step must
    // still render the option (the avatar falls back to the symbol seed).
    tokenAddresses.current = { USDC: FULL_REGISTRY.USDC, EURC: FULL_REGISTRY.EURC };
    render(<TokenStep value="XLM" onChange={vi.fn()} />);

    expect(screen.getAllByRole("radio")[1] as HTMLElement).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Stellar Lumens")).toBeInTheDocument();
    expect(screen.getByText("XL")).toBeInTheDocument();
  });

  it("throws a SorobanCallError for an unsupported token symbol", () => {
    tokenAddresses.current = { ...FULL_REGISTRY };

    expect(() => getTokenAddress("DOGE")).toThrow(SorobanCallError);
    try {
      getTokenAddress("DOGE");
      throw new Error("expected getTokenAddress to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SorobanCallError);
      expect((error as SorobanCallError).message).toBe("Unsupported token: DOGE");
      expect((error as SorobanCallError).code).toBe("Unknown");
    }
  });

  it("resolves the address of a supported token case-insensitively", () => {
    tokenAddresses.current = { ...FULL_REGISTRY };

    const upper = getTokenAddress("USDC");
    expect(typeof upper).toBe("string");
    expect(upper.length).toBeGreaterThan(0);
    expect(getTokenAddress("usdc")).toBe(upper);
  });
});

describe("TokenStep — token decimals metadata (issue #1798)", () => {
  beforeEach(() => {
    clearTokenDecimalsCache();
    simulateTransaction.mockReset();
    getAccount.mockReset();
    getAccount.mockResolvedValue({});
    scValToNative.mockReset();
    scValToNative.mockImplementation((value: unknown) => (value as { value?: unknown })?.value);
  });

  it("returns the decimals reported by the token contract", async () => {
    simulateTransaction.mockResolvedValue({ result: { retval: { value: 6 } } });

    await expect(fetchTokenDecimals(FULL_REGISTRY.USDC)).resolves.toBe(6);
    expect(getCachedTokenDecimals(FULL_REGISTRY.USDC)).toBe(6);
  });

  it("caches the decimals so the contract is queried once", async () => {
    simulateTransaction.mockResolvedValue({ result: { retval: { value: 7 } } });

    await fetchTokenDecimals(FULL_REGISTRY.XLM);
    await fetchTokenDecimals(FULL_REGISTRY.XLM);

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("falls back to 7 decimals when the metadata lookup fails", async () => {
    simulateTransaction.mockResolvedValue({
      error: "HostError: Error(Storage, MissingValue): missing decimals",
    });

    await expect(fetchTokenDecimals(FULL_REGISTRY.USDC)).resolves.toBe(7);
    expect(getCachedTokenDecimals(FULL_REGISTRY.USDC)).toBe(7);
  });

  it("falls back to 7 decimals when the contract returns no value", async () => {
    simulateTransaction.mockResolvedValue({ result: {} });

    await expect(fetchTokenDecimals(FULL_REGISTRY.USDC)).resolves.toBe(7);
  });

  it("falls back to 7 decimals when the decimals value is unsupported", async () => {
    // A decimals value that is neither a number, bigint nor numeric string.
    simulateTransaction.mockResolvedValue({ result: { retval: { value: 6 } } });
    scValToNative.mockReturnValueOnce({ unexpected: true });

    await expect(fetchTokenDecimals(FULL_REGISTRY.USDC)).resolves.toBe(7);
    expect(getCachedTokenDecimals(FULL_REGISTRY.USDC)).toBe(7);
  });

  it("falls back to 7 decimals when the token lookup throws", async () => {
    getAccount.mockRejectedValue(new Error("network unreachable"));

    await expect(fetchTokenDecimals(FULL_REGISTRY.USDC)).resolves.toBe(7);
    expect(getCachedTokenDecimals(FULL_REGISTRY.USDC)).toBe(7);
  });

  it("parses a numeric string decimals value", async () => {
    simulateTransaction.mockResolvedValue({ result: { retval: { value: "6" } } });
    scValToNative.mockReturnValueOnce("6");

    await expect(fetchTokenDecimals(FULL_REGISTRY.USDC)).resolves.toBe(6);
  });

  it("exposes the default decimals for known and unknown symbols", () => {
    expect(getDefaultTokenDecimals("XLM")).toBe(7);
    expect(getDefaultTokenDecimals("usdc")).toBe(7);
    expect(getDefaultTokenDecimals("UNKNOWN")).toBe(7);
  });

  it("returns the default decimals synchronously and reports the fetched value", async () => {
    simulateTransaction.mockResolvedValue({ result: { retval: { value: 6 } } });
    const callback = vi.fn();

    // Synchronously the default is returned while the lookup is in flight.
    expect(getTokenDecimalsSync(FULL_REGISTRY.USDC, callback)).toBe(7);

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith(6);
    });
  });

  it("returns the cached decimals synchronously once known", async () => {
    simulateTransaction.mockResolvedValue({ result: { retval: { value: 6 } } });
    await fetchTokenDecimals(FULL_REGISTRY.USDC);
    simulateTransaction.mockClear();

    expect(getTokenDecimalsSync(FULL_REGISTRY.USDC)).toBe(6);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});
