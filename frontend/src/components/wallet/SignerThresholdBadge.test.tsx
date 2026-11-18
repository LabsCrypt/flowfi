import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignerThresholdBadge } from "./SignerThresholdBadge";
import type { MultisigAccount } from "@/lib/stellar-multisig";

function makeAccount(overrides: Partial<MultisigAccount> = {}): MultisigAccount {
  return {
    publicKey: "GMASTER",
    networkPassphrase: "Test SDF Network ; September 2015",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    sequence: "1",
    signers: [
      { key: "GMASTER", weight: 20, type: "ed25519_public_key" },
      { key: "GCO1", weight: 10, type: "ed25519_public_key" },
      { key: "GCO2", weight: 10, type: "ed25519_public_key" },
    ],
    thresholds: { low: 1, medium: 1, high: 30 },
    masterWeight: 20,
    isMultisig: true,
    connectedSignerWeight: 20,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SignerThresholdBadge", () => {
  it("renders a subdued hint for single-signature accounts", () => {
    render(<SignerThresholdBadge account={makeAccount({ isMultisig: false, signers: [] })} />);

    expect(screen.getByText("Single-signature account")).toBeInTheDocument();
    expect(screen.getByTestId("signer-threshold-badge")).toHaveAttribute("data-multisig", "false");
  });

  it("summarises the signer count and threshold when no envelope is present", () => {
    render(<SignerThresholdBadge account={makeAccount()} />);

    expect(
      screen.getByText("3 signers · High threshold 30"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders signature weight progress when a collected weight is supplied", () => {
    render(<SignerThresholdBadge account={makeAccount()} collectedWeight={20} signedSigners={["GMASTER"]} />);

    expect(
      screen.getByText("1 of 3 signatures collected (weight 20/30)"),
    ).toBeInTheDocument();

    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "67");
  });

  it("caps the progress bar at 100% and marks a satisfied envelope", () => {
    render(<SignerThresholdBadge account={makeAccount()} collectedWeight={40} signedSigners={["GMASTER", "GCO1"]} />);

    expect(screen.getByTestId("signer-threshold-badge")).toHaveAttribute("data-satisfied", "true");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
