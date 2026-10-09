import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/stellar-multisig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar-multisig")>();
  return {
    ...actual,
    evaluateSignatureProgress: vi.fn(),
    signPartialTransaction: vi.fn(),
    submitSignedTransaction: vi.fn(),
    downloadXdrFile: vi.fn(),
  };
});

import { copyToClipboard } from "@/lib/clipboard";
import {
  evaluateSignatureProgress,
  signPartialTransaction,
  submitSignedTransaction,
  type MultisigAccount,
  type SignatureProgress,
} from "@/lib/stellar-multisig";
import { MultisigSignModal } from "./MultisigSignModal";

const account: MultisigAccount = {
  publicKey: "GMASTER",
  networkPassphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  sequence: "1",
  signers: [
    { key: "GMASTER", weight: 20, type: "ed25519_public_key" },
    { key: "GCO1", weight: 10, type: "ed25519_public_key" },
  ],
  thresholds: { low: 1, medium: 1, high: 30 },
  masterWeight: 20,
  isMultisig: true,
  connectedSignerWeight: 20,
  fetchedAt: new Date().toISOString(),
};

function makeProgress(overrides: Partial<SignatureProgress> = {}): SignatureProgress {
  return {
    collectedWeight: 20,
    requiredWeight: 30,
    totalWeight: 30,
    isSatisfied: false,
    signedSigners: [account.signers[0]!],
    unsignedSigners: [account.signers[1]!],
    signedCount: 1,
    totalSignerCount: 2,
    ...overrides,
  };
}

function renderModal(overrides: Partial<React.ComponentProps<typeof MultisigSignModal>> = {}) {
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  const onXdrChange = vi.fn();

  const result = render(
    <MultisigSignModal
      account={account}
      initialXdr="PARTIAL_XDR"
      onClose={onClose}
      onSubmitted={onSubmitted}
      onXdrChange={onXdrChange}
      {...overrides}
    />,
  );

  return { onClose, onSubmitted, onXdrChange, ...result };
}

describe("MultisigSignModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(evaluateSignatureProgress).mockResolvedValue(makeProgress());
    vi.mocked(signPartialTransaction).mockResolvedValue("RESIGNED_XDR");
    vi.mocked(submitSignedTransaction).mockResolvedValue({ txHash: "HASH123" });
  });

  it("shows the collected signature progress and keeps broadcast disabled", async () => {
    renderModal();

    await waitFor(() =>
      expect(
        screen.getByText("1 of 2 signatures collected (weight 20/30)"),
      ).toBeInTheDocument(),
    );

    const broadcast = screen.getByRole("button", { name: /waiting for signatures/i });
    expect(broadcast).toBeDisabled();
  });

  it("enables broadcast once the threshold is met and submits the envelope", async () => {
    vi.mocked(evaluateSignatureProgress).mockResolvedValue(
      makeProgress({ collectedWeight: 30, isSatisfied: true, signedCount: 2 }),
    );
    const { onSubmitted } = renderModal();

    const broadcast = await screen.findByRole("button", { name: /broadcast transaction/i });
    await waitFor(() => expect(broadcast).toBeEnabled());

    fireEvent.click(broadcast);

    await waitFor(() =>
      expect(submitSignedTransaction).toHaveBeenCalledWith(
        "PARTIAL_XDR",
        account.networkPassphrase,
        account.rpcUrl,
      ),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith("HASH123"));
  });

  it("appends the wallet signature and re-evaluates the new envelope", async () => {
    const { onXdrChange } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /add my signature/i }));

    await waitFor(() =>
      expect(signPartialTransaction).toHaveBeenCalledWith(
        "PARTIAL_XDR",
        account.networkPassphrase,
      ),
    );
    await waitFor(() => expect(onXdrChange).toHaveBeenCalledWith("RESIGNED_XDR"));
    await waitFor(() =>
      expect(evaluateSignatureProgress).toHaveBeenCalledWith(
        "RESIGNED_XDR",
        account,
        account.networkPassphrase,
        "high",
      ),
    );
  });

  it("copies the raw XDR to the clipboard", async () => {
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /copy xdr/i }));

    expect(copyToClipboard).toHaveBeenCalledWith("PARTIAL_XDR", {
      successMessage: "Transaction XDR copied",
    });
  });

  it("exposes a SEP-0007 deep link for mobile signers", () => {
    renderModal();

    const link = screen.getByTestId("sep0007-link");
    expect(link.getAttribute("href")).toMatch(/^web\+stellar:tx\?/);
    expect(link.getAttribute("href")).toContain("xdr=PARTIAL_XDR");
  });

  it("closes the dialog when the close button is clicked", () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
