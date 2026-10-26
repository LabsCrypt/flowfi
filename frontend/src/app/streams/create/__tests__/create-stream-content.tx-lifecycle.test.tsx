/**
 * Create-stream transaction lifecycle tests (issue #1794).
 *
 * Creating a stream is a multi-phase operation: the wallet signs the
 * transaction, the network confirms it (the Soroban client polls the RPC
 * until the transaction reaches a terminal state) and only then is the
 * stream considered created. This file pins down every terminal state of
 * that lifecycle as observed by the page:
 *
 *  - success   → the transaction is confirmed, the draft is discarded and the
 *                user is redirected to the dashboard,
 *  - timeout   → the confirmation never arrives,
 *  - failure   → the transaction failed on-chain,
 *  - cancellation → the user rejected the transaction in the wallet,
 *  - validation/dependency failures → the submission never reaches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

const VALID_KEY = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";

const push = vi.fn();
const searchParamsMock = { get: vi.fn() };

const mockUseWallet = vi.hoisted(() =>
  vi.fn(() => ({
    status: "disconnected",
    session: null as null | { publicKey: string },
  })),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParamsMock,
}));

vi.mock("react-hot-toast", () => {
  const toast = { success: vi.fn(), error: vi.fn(), loading: vi.fn() };
  return { default: toast, toast };
});

vi.mock("@/context/wallet-context", () => ({
  useWallet: mockUseWallet,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/soroban", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/soroban")>();
  return {
    ...actual,
    createStream: vi.fn(),
    fetchTokenBalanceDisplay: vi.fn(),
  };
});

import CreateStreamContent from "../create-stream-content";
import { createStream, fetchTokenBalanceDisplay, SorobanCallError } from "@/lib/soroban";
import { toast } from "react-hot-toast";

const mockedCreateStream = vi.mocked(createStream);
const mockedFetchBalance = vi.mocked(fetchTokenBalanceDisplay);

function getRecipientInput() {
  return screen.getByLabelText(/recipient/i) as HTMLInputElement;
}

function getAmountInput() {
  return screen.getByLabelText(/total amount/i) as HTMLInputElement;
}

function getSubmitButton() {
  return screen.getByRole("button", { name: /start streaming|confirm in wallet|finalizing stream|submitting to network|processing/i });
}

/** Fill in a valid recipient and amount and submit the form. */
async function submitValidForm(amount = "100") {
  await act(async () => {
    fireEvent.change(getRecipientInput(), { target: { value: VALID_KEY } });
    fireEvent.change(getAmountInput(), { target: { value: amount } });
  });

  await act(async () => {
    fireEvent.click(getSubmitButton());
  });
}

describe("CreateStreamContent transaction lifecycle (issue #1794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsMock.get.mockReturnValue(null);
    mockUseWallet.mockReturnValue({ status: "connected", session: { publicKey: VALID_KEY } });
    mockedFetchBalance.mockResolvedValue("1000");
    mockedCreateStream.mockResolvedValue({ success: true, txHash: "tx_hash" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Success ────────────────────────────────────────────────────────────────

  it("submits the stream with the converted amount and duration", async () => {
    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(mockedCreateStream).toHaveBeenCalledTimes(1);
    });

    const call = mockedCreateStream.mock.calls[0];
    expect(call).toBeDefined();
    const [session, params] = call!;
    expect(session.publicKey).toBe(VALID_KEY);
    expect(params.recipient).toBe(VALID_KEY);
    expect(params.amount).toBe(1_000_000_000n); // 100 * 10^7 stroops
    expect(params.durationSeconds).toBe(2_592_000n); // 30 days
    expect(typeof params.tokenAddress).toBe("string");
  });

  it("shows the signing state while the transaction is being confirmed", async () => {
    let resolveSubmit!: (value: { success: true; txHash: string }) => void;
    mockedCreateStream.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirm in wallet/i })).toBeDisabled();
    });

    await act(async () => {
      resolveSubmit({ success: true, txHash: "tx_hash" });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /finalizing stream/i })).toBeInTheDocument();
    });
  });

  it("confirms the stream, notifies the user and redirects to the dashboard", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /finalizing stream/i })).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith("Stream created successfully!");

    // The redirect happens after the success toast has been shown.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(push).toHaveBeenCalledWith("/dashboard");
    expect(screen.getByRole("button", { name: /start streaming/i })).toBeEnabled();
  });

  // ── Timeout ────────────────────────────────────────────────────────────────

  it("surfaces a confirmation timeout and does not redirect", async () => {
    mockedCreateStream.mockRejectedValue(
      new SorobanCallError("Transaction confirmation timed out.", "NetworkError"),
    );

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Transaction confirmation timed out.");
    });
    expect(push).not.toHaveBeenCalled();
    // The form is usable again so the user can retry.
    expect(screen.getByRole("button", { name: /start streaming/i })).toBeEnabled();
  });

  it("maps a generic timeout error to the network-congestion message", async () => {
    mockedCreateStream.mockRejectedValue(new Error("Request timeout"));

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Transaction timed out. The network may be congested — please try again.",
      );
    });
  });

  // ── Failed transaction ─────────────────────────────────────────────────────

  it("surfaces an on-chain failure and does not redirect", async () => {
    mockedCreateStream.mockRejectedValue(
      new SorobanCallError("Transaction failed on-chain.", "NetworkError"),
    );

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Transaction failed on-chain.");
    });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /start streaming/i })).toBeEnabled();
  });

  it("maps an insufficient-balance failure to a readable message", async () => {
    mockedCreateStream.mockRejectedValue(new Error("insufficient balance"));

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Insufficient balance to complete this transaction.",
      );
    });
  });

  it("logs the failure before reporting it to the user", async () => {
    const { logger } = await import("@/lib/logger");
    mockedCreateStream.mockRejectedValue(
      new SorobanCallError("Transaction failed on-chain.", "NetworkError"),
    );

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        "Stream creation failed:",
        expect.any(SorobanCallError),
      );
    });
  });

  // ── Cancellation ───────────────────────────────────────────────────────────

  it("reports a wallet cancellation with the rejection message", async () => {
    mockedCreateStream.mockRejectedValue(new Error("User rejected the request"));

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Transaction was rejected in your wallet.",
      );
    });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /start streaming/i })).toBeEnabled();
  });

  it("reports a wallet cancellation raised as a SorobanCallError", async () => {
    mockedCreateStream.mockRejectedValue(
      new SorobanCallError("Transaction was rejected in wallet.", "WalletRejected"),
    );

    render(<CreateStreamContent />);
    await submitValidForm("100");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Transaction was rejected in wallet.");
    });
  });

  // ── Validation and dependency failures ─────────────────────────────────────

  it("does not submit when the recipient is invalid and reports the error", async () => {
    render(<CreateStreamContent />);

    await act(async () => {
      fireEvent.change(getRecipientInput(), { target: { value: "not-a-valid-key" } });
      fireEvent.change(getAmountInput(), { target: { value: "100" } });
    });

    await act(async () => {
      fireEvent.click(getSubmitButton());
    });

    expect(mockedCreateStream).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Invalid Stellar public key (must start with 'G' and be 56 characters)",
    );
  });

  it("does not submit when the amount exceeds the wallet balance", async () => {
    mockedFetchBalance.mockResolvedValue("100");

    render(<CreateStreamContent />);

    await act(async () => {
      fireEvent.change(getRecipientInput(), { target: { value: VALID_KEY } });
      fireEvent.change(getAmountInput(), { target: { value: "500" } });
    });

    // Let the balance lookup settle so the amount can be validated against it.
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(getSubmitButton());
    });

    expect(mockedCreateStream).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Amount exceeds wallet balance");
  });

  it("keeps the submit button disabled while the wallet is disconnected", () => {
    mockUseWallet.mockReturnValue({ status: "disconnected", session: null });

    render(<CreateStreamContent />);

    expect(screen.getByRole("button", { name: /start streaming/i })).toBeDisabled();
    expect(
      screen.getByText(/please connect your wallet to create a stream/i),
    ).toBeInTheDocument();
  });

  it("surfaces a wallet balance lookup failure without blocking the form", async () => {
    mockedFetchBalance.mockRejectedValue(new Error("rpc down"));

    render(<CreateStreamContent />);

    await act(async () => {
      fireEvent.change(getAmountInput(), { target: { value: "100" } });
    });

    await waitFor(() => {
      expect(
        screen.getByText(/unable to fetch wallet balance/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /start streaming/i })).toBeEnabled();
  });
});
