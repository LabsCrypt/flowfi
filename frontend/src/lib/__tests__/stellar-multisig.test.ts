import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  assessMultisigRouting,
  buildQrCodeUrl,
  buildSep0007TxUri,
  clearMultisigAccountCache,
  createProposal,
  deleteProposal,
  evaluateSignatureProgress,
  fetchMultisigAccount,
  isMultisigAccountInfo,
  listProposals,
  mapHorizonAccount,
  MultisigError,
  needsCoSigners,
  normalizeThresholds,
  parseSep0007TxUri,
  requiredWeightForLevel,
  saveProposal,
  sumSignerWeights,
  updateProposal,
  type MultisigAccount,
  type MultisigSigner,
} from "../stellar-multisig";

const PASSPHRASE = Networks.TESTNET;

/** Builds a randomly-sourced payment envelope signed by each provided key. */
function buildEnvelope(signerKeypairs: Keypair[]) {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "1");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();

  for (const keypair of signerKeypairs) {
    tx.sign(keypair);
  }

  return { xdr: tx.toXDR(), source };
}

const HORIZON_CONTEXT = {
  publicKey: "",
  networkPassphrase: PASSPHRASE,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
};

function horizonPayload(input: {
  publicKey: string;
  signers: MultisigSigner[];
  thresholds?: { low: number; medium: number; high: number };
}) {
  return {
    account_id: input.publicKey,
    sequence: "42",
    thresholds: {
      low_threshold: input.thresholds?.low ?? 1,
      med_threshold: input.thresholds?.medium ?? 1,
      high_threshold: input.thresholds?.high ?? 2,
    },
    signers: input.signers.map((signer) => ({
      key: signer.key,
      weight: signer.weight,
      type: signer.type,
    })),
  };
}

describe("multisig account detection", () => {
  it("treats a single default signer as a non-multisig EOA", () => {
    expect(
      isMultisigAccountInfo({
        signers: [{ key: "GMASTER", weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 1, medium: 1, high: 1 },
      }),
    ).toBe(false);
  });

  it("flags accounts with more than one signer", () => {
    expect(
      isMultisigAccountInfo({
        signers: [
          { key: "GMASTER", weight: 1, type: "ed25519_public_key" },
          { key: "GOTHER", weight: 1, type: "ed25519_public_key" },
        ],
        thresholds: { low: 1, medium: 1, high: 1 },
      }),
    ).toBe(true);
  });

  it("flags accounts with raised thresholds", () => {
    expect(
      isMultisigAccountInfo({
        signers: [{ key: "GMASTER", weight: 1, type: "ed25519_public_key" }],
        thresholds: { low: 1, medium: 1, high: 2 },
      }),
    ).toBe(true);
  });

  it("normalizes missing thresholds/signers defensively", () => {
    expect(normalizeThresholds(undefined)).toEqual({ low: 1, medium: 1, high: 1 });
    expect(sumSignerWeights([])).toBe(0);
  });
});

describe("mapHorizonAccount", () => {
  it("derives multisig flags and the connected signer weight", () => {
    const master = Keypair.random();
    const coSigner = Keypair.random();

    const account = mapHorizonAccount(
      horizonPayload({
        publicKey: master.publicKey(),
        thresholds: { low: 1, medium: 1, high: 2 },
        signers: [
          { key: master.publicKey(), weight: 1, type: "ed25519_public_key" },
          { key: coSigner.publicKey(), weight: 1, type: "ed25519_public_key" },
        ],
      }),
      { ...HORIZON_CONTEXT, publicKey: master.publicKey() },
    );

    expect(account.isMultisig).toBe(true);
    expect(account.connectedSignerWeight).toBe(1);
    expect(account.masterWeight).toBe(1);
    expect(account.signers).toHaveLength(2);
    expect(account.sequence).toBe("42");
  });

  it("reports zero connected weight when the key is not a signer", () => {
    const account = mapHorizonAccount(
      horizonPayload({
        publicKey: Keypair.random().publicKey(),
        signers: [{ key: Keypair.random().publicKey(), weight: 3, type: "ed25519_public_key" }],
      }),
      HORIZON_CONTEXT,
    );

    expect(account.connectedSignerWeight).toBe(0);
  });
});

describe("requiredWeightForLevel / needsCoSigners", () => {
  const account: MultisigAccount = {
    ...mapHorizonAccount(
      horizonPayload({
        publicKey: "GMASTER",
        thresholds: { low: 1, medium: 1, high: 2 },
        signers: [
          { key: "GMASTER", weight: 1, type: "ed25519_public_key" },
          { key: "GOTHER", weight: 1, type: "ed25519_public_key" },
        ],
      }),
      { ...HORIZON_CONTEXT, publicKey: "GMASTER" },
    ),
  };

  it("reads the requested threshold category", () => {
    expect(requiredWeightForLevel(account.thresholds, "low")).toBe(1);
    expect(requiredWeightForLevel(account.thresholds, "high")).toBe(2);
  });

  it("needs co-signers when the connected weight is below the threshold", () => {
    expect(needsCoSigners(account)).toBe(true);
  });

  it("does not need co-signers for plain accounts", () => {
    expect(needsCoSigners({ ...account, isMultisig: false })).toBe(false);
  });
});

describe("evaluateSignatureProgress", () => {
  const master = Keypair.random();
  const coSigner = Keypair.random();
  const signers: MultisigSigner[] = [
    { key: master.publicKey(), weight: 20, type: "ed25519_public_key" },
    { key: coSigner.publicKey(), weight: 10, type: "ed25519_public_key" },
  ];
  const thresholds = { low: 1, medium: 1, high: 30 };

  it("reports the weight collected by a single signature", async () => {
    const { xdr } = buildEnvelope([master]);
    const progress = await evaluateSignatureProgress(
      xdr,
      { signers, thresholds },
      PASSPHRASE,
      "high",
    );

    expect(progress.collectedWeight).toBe(20);
    expect(progress.requiredWeight).toBe(30);
    expect(progress.totalWeight).toBe(30);
    expect(progress.isSatisfied).toBe(false);
    expect(progress.signedCount).toBe(1);
    expect(progress.unsignedSigners).toHaveLength(1);
  });

  it("reports a satisfied envelope once both signers have signed", async () => {
    const { xdr } = buildEnvelope([master, coSigner]);
    const progress = await evaluateSignatureProgress(
      xdr,
      { signers, thresholds },
      PASSPHRASE,
      "high",
    );

    expect(progress.collectedWeight).toBe(30);
    expect(progress.isSatisfied).toBe(true);
    expect(progress.signedCount).toBe(2);
  });

  it("rejects malformed XDR", async () => {
    await expect(
      evaluateSignatureProgress("not-xdr", { signers, thresholds }, PASSPHRASE),
    ).rejects.toMatchObject({ name: "MultisigError", code: "InvalidXdr" });
  });
});

describe("SEP-0007 URIs", () => {
  it("round-trips an xdr and its metadata", () => {
    const uri = buildSep0007TxUri({
      xdr: "AAAAAg==",
      networkPassphrase: PASSPHRASE,
      msg: "Approve payroll stream",
      callback: "https://flowfi.example/api/callback",
      pubkey: "GABC",
    });

    expect(uri.startsWith("web+stellar:tx?")).toBe(true);
    expect(uri).not.toContain("AAAAAg==&");

    const parsed = parseSep0007TxUri(uri);
    expect(parsed).toMatchObject({
      xdr: "AAAAAg==",
      networkPassphrase: PASSPHRASE,
      msg: "Approve payroll stream",
      callback: "https://flowfi.example/api/callback",
      pubkey: "GABC",
    });
  });

  it("returns null for unrelated or malformed URIs", () => {
    expect(parseSep0007TxUri("https://example.com")).toBeNull();
    expect(parseSep0007TxUri("web+stellar:tx?msg=no-xdr")).toBeNull();
  });

  it("builds a QR image URL carrying the payload", () => {
    const url = buildQrCodeUrl("web+stellar:tx?xdr=AA%2BB", { size: 100 });
    expect(url).toContain("data=web%2Bstellar%3Atx%3Fxdr%3DAA%252BB");
    expect(url).toContain("size=100x100");
  });
});

describe("proposal store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("creates, saves, updates and deletes a proposal", () => {
    const proposal = createProposal({
      account: "GABC",
      xdr: "AAAA",
      networkPassphrase: PASSPHRASE,
      createdBy: "GABC",
    });

    saveProposal(proposal);
    expect(listProposals("GABC")).toHaveLength(1);

    const updated = updateProposal(proposal.id, { status: "submitted" });
    expect(updated?.status).toBe("submitted");
    expect(listProposals()).toHaveLength(1);

    deleteProposal(proposal.id);
    expect(listProposals()).toHaveLength(0);
  });

  it("filters proposals by account", () => {
    saveProposal(
      createProposal({ account: "G1", xdr: "a", networkPassphrase: PASSPHRASE, createdBy: "G1" }),
    );
    saveProposal(
      createProposal({ account: "G2", xdr: "b", networkPassphrase: PASSPHRASE, createdBy: "G2" }),
    );

    expect(listProposals("G1")).toHaveLength(1);
    expect(listProposals()).toHaveLength(2);
  });

  it("returns null when updating a missing proposal", () => {
    expect(updateProposal("missing", { status: "failed" })).toBeNull();
  });
});

describe("fetchMultisigAccount", () => {
  const master = Keypair.random();

  beforeEach(() => {
    clearMultisigAccountCache();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a Horizon response into a MultisigAccount", async () => {
    const payload = horizonPayload({
      publicKey: master.publicKey(),
      thresholds: { low: 1, medium: 1, high: 2 },
      signers: [
        { key: master.publicKey(), weight: 1, type: "ed25519_public_key" },
        { key: Keypair.random().publicKey(), weight: 1, type: "ed25519_public_key" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload }),
    );

    const account = await fetchMultisigAccount(master.publicKey(), { networkId: "testnet" });

    expect(account.isMultisig).toBe(true);
    expect(account.networkPassphrase).toBe(PASSPHRASE);
    expect(account.horizonUrl).toContain("horizon-testnet");
  });

  it("throws AccountNotFound on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );

    await expect(
      fetchMultisigAccount(master.publicKey(), { networkId: "testnet" }),
    ).rejects.toMatchObject({ name: "MultisigError", code: "AccountNotFound" });
  });
});

describe("assessMultisigRouting", () => {
  const master = Keypair.random();
  const coSigner = Keypair.random();

  beforeEach(() => {
    clearMultisigAccountCache();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a below-threshold envelope to the proposal flow", async () => {
    const payload = horizonPayload({
      publicKey: master.publicKey(),
      thresholds: { low: 1, medium: 1, high: 2 },
      signers: [
        { key: master.publicKey(), weight: 1, type: "ed25519_public_key" },
        { key: coSigner.publicKey(), weight: 1, type: "ed25519_public_key" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload }),
    );

    const { xdr } = buildEnvelope([master]);
    const routing = await assessMultisigRouting({
      publicKey: master.publicKey(),
      signedXdr: xdr,
      networkPassphrase: PASSPHRASE,
      networkId: "testnet",
    });

    expect(routing?.needsProposal).toBe(true);
    expect(routing?.progress.collectedWeight).toBe(1);
  });

  it("returns null for single-signature accounts", async () => {
    const payload = horizonPayload({
      publicKey: master.publicKey(),
      thresholds: { low: 1, medium: 1, high: 1 },
      signers: [{ key: master.publicKey(), weight: 1, type: "ed25519_public_key" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload }),
    );

    const { xdr } = buildEnvelope([master]);
    const routing = await assessMultisigRouting({
      publicKey: master.publicKey(),
      signedXdr: xdr,
      networkPassphrase: PASSPHRASE,
      networkId: "testnet",
    });

    expect(routing).toBeNull();
  });

  it("fails open (null) when Horizon is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const { xdr } = buildEnvelope([master]);
    const routing = await assessMultisigRouting({
      publicKey: master.publicKey(),
      signedXdr: xdr,
      networkPassphrase: PASSPHRASE,
      networkId: "testnet",
    });

    expect(routing).toBeNull();
  });
});

describe("MultisigError", () => {
  it("defaults to a NetworkError code", () => {
    const error = new MultisigError("boom");
    expect(error.code).toBe("NetworkError");
    expect(error.name).toBe("MultisigError");
  });
});
