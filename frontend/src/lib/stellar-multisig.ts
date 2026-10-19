/**
 * lib/stellar-multisig.ts
 *
 * Native multisig & smart-account support for FlowFi (issue #1471).
 *
 * FlowFi's contract calls are normally single-signature: Freighter signs the
 * assembled Soroban envelope and the app broadcasts it. Corporate/institutional
 * treasuries instead hold funds on Stellar multisig accounts (multiple signers,
 * weighted thresholds), where a single signature is below the required weight.
 * Broadcasting such an envelope fails with `tx_bad_auth` before the user ever
 * gets a chance to collect co-signatures.
 *
 * This module provides the pieces the UI needs to detect that situation and
 * coordinate partial signatures:
 *
 *  1. `fetchMultisigAccount` – read signers + thresholds from Horizon.
 *  2. `evaluateSignatureProgress` – quantify how much signature weight a
 *     (partially) signed envelope has already collected.
 *  3. `assessMultisigRouting` – decide whether a signed envelope must be routed
 *     into the multisig proposal flow instead of being broadcast directly.
 *  4. `buildSep0007TxUri` / `parseSep0007TxUri` – SEP-0007 deep links that let
 *     mobile signer wallets (LOBSTR Vault, xBull, …) import an envelope.
 *  5. A small localStorage-backed proposal store so co-signers can hand
 *     envelopes around before the flow is wired to a backend relay.
 *
 * Everything network/YAML-heavy is imported lazily so this module stays cheap
 * to import in the browser (and safe to pull into client components).
 */

import { getNetworkConfig, type NetworkConfig, type NetworkId } from "@/lib/stellar-config";
import { logger } from "@/lib/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Stellar operation threshold category the envelope must satisfy. */
export type ThresholdLevel = "low" | "medium" | "high";

/** Soroban / contract invocations are *high* threshold operations. */
export const CONTRACT_OPERATION_THRESHOLD_LEVEL: ThresholdLevel = "high";

export interface MultisigSigner {
  /** Strkey of the signer (G… for ed25519, X… for pre-auth tx, …). */
  key: string;
  weight: number;
  type: string;
}

export interface AccountThresholds {
  low: number;
  medium: number;
  high: number;
}

export interface MultisigAccount {
  publicKey: string;
  networkPassphrase: string;
  horizonUrl: string;
  rpcUrl: string;
  sequence: string;
  signers: MultisigSigner[];
  thresholds: AccountThresholds;
  /** Weight of the master key, or 0 when the master key is disabled. */
  masterWeight: number;
  /** True when the account has more than one signer or raised thresholds. */
  isMultisig: boolean;
  /** Weight the currently connected key contributes (0 if it isn't a signer). */
  connectedSignerWeight: number;
  fetchedAt: string;
}

export interface SignatureProgress {
  /** Sum of the weights of the signers whose signature is present in the XDR. */
  collectedWeight: number;
  /** Weight required for the given threshold level. */
  requiredWeight: number;
  /** Sum of the weights of every signer on the account. */
  totalWeight: number;
  isSatisfied: boolean;
  signedSigners: MultisigSigner[];
  unsignedSigners: MultisigSigner[];
  signedCount: number;
  totalSignerCount: number;
}

export type MultisigErrorCode =
  | "AccountNotFound"
  | "NetworkError"
  | "InvalidXdr"
  | "SubmissionFailed";

export class MultisigError extends Error {
  constructor(
    message: string,
    public readonly code: MultisigErrorCode = "NetworkError",
  ) {
    super(message);
    this.name = "MultisigError";
  }
}

// ── Network helpers ───────────────────────────────────────────────────────────

/**
 * Mirrors `activeNetworkConfig()` in `lib/soroban.ts` so the passphrase used to
 * build/parse envelopes always matches the one used to broadcast them.
 */
export function resolveActiveNetworkId(): NetworkId {
  const stored =
    typeof window === "undefined" ? null : window.localStorage.getItem("flowfi.network");
  if (stored === "mainnet" || stored === "futurenet" || stored === "sandbox") {
    return stored;
  }
  return "testnet";
}

// ── Horizon account parsing / detection ───────────────────────────────────────

interface HorizonAccountResponse {
  id?: string;
  account_id?: string;
  sequence?: string;
  thresholds?: {
    low_threshold?: number;
    med_threshold?: number;
    high_threshold?: number;
  };
  signers?: Array<{ key?: string; weight?: number; type?: string }>;
}

export function normalizeThresholds(
  thresholds: HorizonAccountResponse["thresholds"],
): AccountThresholds {
  return {
    low: thresholds?.low_threshold ?? 1,
    medium: thresholds?.med_threshold ?? 1,
    high: thresholds?.high_threshold ?? 1,
  };
}

export function normalizeSigners(
  signers: HorizonAccountResponse["signers"],
): MultisigSigner[] {
  return (signers ?? [])
    .filter((signer): signer is { key: string; weight?: number; type?: string } =>
      typeof signer?.key === "string",
    )
    .map((signer) => ({
      key: signer.key,
      weight: signer.weight ?? 0,
      type: signer.type ?? "ed25519_public_key",
    }));
}

/**
 * An account is considered "multisig" when it either has more than one signer
 * or has raised any of its operation thresholds. A single-signer account with
 * default thresholds (all 1, master weight 1) is a plain EOA.
 */
export function isMultisigAccountInfo(input: {
  signers: MultisigSigner[];
  thresholds: AccountThresholds;
}): boolean {
  const { signers, thresholds } = input;
  const raisedThreshold =
    thresholds.low > 1 || thresholds.medium > 1 || thresholds.high > 1;
  const disabledMaster =
    signers.length > 0 && !signers.some((signer) => signer.weight >= thresholds.high);
  return signers.length > 1 || raisedThreshold || disabledMaster;
}

export function requiredWeightForLevel(
  thresholds: AccountThresholds,
  level: ThresholdLevel,
): number {
  return thresholds[level];
}

export function sumSignerWeights(signers: MultisigSigner[]): number {
  return signers.reduce((total, signer) => total + signer.weight, 0);
}

/**
 * Converts a raw Horizon account payload into the shape the UI works with.
 * Pure so it can be unit tested without touching the network.
 */
export function mapHorizonAccount(
  payload: HorizonAccountResponse,
  context: {
    publicKey: string;
    networkPassphrase: string;
    horizonUrl: string;
    rpcUrl: string;
  },
): MultisigAccount {
  const signers = normalizeSigners(payload.signers);
  const thresholds = normalizeThresholds(payload.thresholds);
  const masterSigner = signers.find((signer) => signer.key === context.publicKey);

  return {
    publicKey: context.publicKey,
    networkPassphrase: context.networkPassphrase,
    horizonUrl: context.horizonUrl,
    rpcUrl: context.rpcUrl,
    sequence: payload.sequence ?? "0",
    signers,
    thresholds,
    masterWeight: masterSigner?.weight ?? 0,
    isMultisig: isMultisigAccountInfo({ signers, thresholds }),
    connectedSignerWeight: masterSigner?.weight ?? 0,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Horizon fetching (with a tiny TTL cache) ─────────────────────────────────

interface CacheEntry {
  account: MultisigAccount;
  cachedAt: number;
}

const ACCOUNT_CACHE_TTL_MS = 60_000;
const accountCache = new Map<string, CacheEntry>();

/** Exposed for tests — clears the module-level account cache. */
export function clearMultisigAccountCache(): void {
  accountCache.clear();
}

export interface FetchMultisigAccountOptions {
  networkId?: NetworkId;
  /** Skip the short-lived cache and always hit Horizon. */
  bypassCache?: boolean;
  signal?: AbortSignal;
}

export async function fetchMultisigAccount(
  publicKey: string,
  options: FetchMultisigAccountOptions = {},
): Promise<MultisigAccount> {
  const networkId = options.networkId ?? resolveActiveNetworkId();
  const config: NetworkConfig = getNetworkConfig(networkId);
  const cacheKey = `${config.id}:${publicKey}`;

  if (!options.bypassCache) {
    const cached = accountCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < ACCOUNT_CACHE_TTL_MS) {
      return cached.account;
    }
  }

  let response: Response;
  try {
    response = await fetch(`${config.horizonUrl}/accounts/${publicKey}`, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    logger.warn("Horizon account lookup failed", error);
    throw new MultisigError(
      "Could not reach Horizon to inspect account signers.",
      "NetworkError",
    );
  }

  if (response.status === 404) {
    throw new MultisigError(
      "This account is not funded on the selected network.",
      "AccountNotFound",
    );
  }

  if (!response.ok) {
    throw new MultisigError(
      `Horizon returned an unexpected status (${response.status}).`,
      "NetworkError",
    );
  }

  const payload = (await response.json()) as HorizonAccountResponse;
  const account = mapHorizonAccount(payload, {
    publicKey,
    networkPassphrase: config.passphrase,
    horizonUrl: config.horizonUrl,
    rpcUrl: config.rpcUrl,
  });

  accountCache.set(cacheKey, { account, cachedAt: Date.now() });
  return account;
}

// ── Signature weight evaluation ──────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * stellar-sdk's `SignatureHint` wraps the four bytes and only exposes them via
 * `toString("hex")`, so normalise it to the same lowercase hex as `toHex`.
 */
function hintToHex(hint: unknown): string {
  const value = hint as { toString(encoding?: string): string };
  return value.toString("hex").toLowerCase();
}

/**
 * Last four bytes of a signer's public key, used as the envelope signature
 * hint. Needs the SDK loaded (for StrKey decoding) so it is created from within
 * the async evaluator below rather than being a standalone sync helper.
 */
function signerHintFromSdk(
  sdk: Awaited<ReturnType<typeof loadSdk>>,
  key: string,
): string | null {
  try {
    const raw = sdk.StrKey.decodeEd25519PublicKey(key);
    return toHex(raw.subarray(raw.length - 4));
  } catch {
    return null;
  }
}

async function loadSdk() {
  return import("@stellar/stellar-sdk");
}

/**
 * Counts how much signing weight an envelope has collected by matching each
 * `DecoratedSignature` hint against the account's signers.
 *
 * Accepts either the whole account or just its signer list; pass the account
 * when you also want threshold checks.
 */
export async function evaluateSignatureProgress(
  xdr: string,
  account: Pick<MultisigAccount, "signers" | "thresholds"> | MultisigSigner[],
  networkPassphrase: string,
  level: ThresholdLevel = CONTRACT_OPERATION_THRESHOLD_LEVEL,
): Promise<SignatureProgress> {
  const signers = Array.isArray(account) ? account : account.signers;
  const thresholds: AccountThresholds = Array.isArray(account)
    ? { low: 1, medium: 1, high: 1 }
    : account.thresholds;

  const sdk = await loadSdk();

  let signedHints: Set<string>;
  try {
    const envelope = sdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
    const signatures = envelope.signatures ?? [];
    signedHints = new Set(signatures.map((signature) => hintToHex(signature.hint)));
  } catch {
    throw new MultisigError("The supplied transaction envelope is not valid XDR.", "InvalidXdr");
  }

  const signedSigners: MultisigSigner[] = [];
  const unsignedSigners: MultisigSigner[] = [];

  for (const signer of signers) {
    const hint = signerHintFromSdk(sdk, signer.key);
    if (hint && signedHints.has(hint)) {
      signedSigners.push(signer);
    } else {
      unsignedSigners.push(signer);
    }
  }

  const collectedWeight = sumSignerWeights(signedSigners);
  const requiredWeight = requiredWeightForLevel(thresholds, level);
  const totalWeight = sumSignerWeights(signers);

  return {
    collectedWeight,
    requiredWeight,
    totalWeight,
    isSatisfied: collectedWeight >= requiredWeight,
    signedSigners,
    unsignedSigners,
    signedCount: signedSigners.length,
    totalSignerCount: signers.length,
  };
}

/**
 * True when the connected signer's own weight is not enough on its own, i.e.
 * the user will need at least one co-signer before the envelope can be
 * broadcast.
 */
export function needsCoSigners(
  account: MultisigAccount,
  level: ThresholdLevel = CONTRACT_OPERATION_THRESHOLD_LEVEL,
): boolean {
  if (!account.isMultisig) return false;
  return account.connectedSignerWeight < requiredWeightForLevel(account.thresholds, level);
}

// ── Routing decision used by the Soroban call path ───────────────────────────

export interface MultisigRoutingResult {
  account: MultisigAccount;
  progress: SignatureProgress;
  /** The envelope is below threshold and must become a co-signing proposal. */
  needsProposal: boolean;
}

/**
 * Inspects a freshly signed envelope against the signer's account. Returns
 * `null` for plain EOA accounts (or when Horizon can't be reached) so the
 * caller can safely fall back to the normal broadcast path — a multisig check
 * must never block a legitimate single-signature transaction.
 */
export async function assessMultisigRouting(params: {
  publicKey: string;
  signedXdr: string;
  networkPassphrase: string;
  level?: ThresholdLevel;
  networkId?: NetworkId;
}): Promise<MultisigRoutingResult | null> {
  try {
    const account = await fetchMultisigAccount(params.publicKey, {
      networkId: params.networkId,
    });
    if (!account.isMultisig) return null;

    const progress = await evaluateSignatureProgress(
      params.signedXdr,
      account,
      params.networkPassphrase,
      params.level ?? CONTRACT_OPERATION_THRESHOLD_LEVEL,
    );

    return { account, progress, needsProposal: !progress.isSatisfied };
  } catch (error) {
    logger.warn("Multisig routing assessment skipped", error);
    return null;
  }
}

// ── Wallet signing (no broadcast) ────────────────────────────────────────────

/**
 * Adds the connected wallet's signature to an envelope *without* broadcasting
 * it. Used both to build the initial partial signature and to append a
 * co-signer's signature inside the proposal modal.
 */
export async function signPartialTransaction(
  xdr: string,
  networkPassphrase: string,
): Promise<string> {
  const { signTransaction } = await import("@stellar/freighter-api");
  const { signedTxXdr, error } = await signTransaction(xdr, { networkPassphrase });

  if (error) {
    const message = typeof error === "string" ? error : (error as Error).message;
    throw new MultisigError(message, "SubmissionFailed");
  }
  if (!signedTxXdr) {
    throw new MultisigError("The wallet did not return a signed envelope.", "SubmissionFailed");
  }
  return signedTxXdr;
}

// ── Submission ───────────────────────────────────────────────────────────────

const SUBMISSION_POLL_ATTEMPTS = 20;
const SUBMISSION_POLL_INTERVAL_MS = 1000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Broadcasts a fully-signed envelope and waits for it to confirm on-chain.
 * Only call this once `SignatureProgress.isSatisfied` is true.
 */
export async function submitSignedTransaction(
  xdr: string,
  networkPassphrase: string,
  rpcUrl?: string,
): Promise<{ txHash: string }> {
  const sdk = await loadSdk();
  const config = getNetworkConfig(resolveActiveNetworkId());
  const server = new sdk.rpc.Server(rpcUrl ?? config.rpcUrl, {
    allowHttp: (rpcUrl ?? config.rpcUrl).startsWith("http://"),
  });

  let tx;
  try {
    tx = sdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new MultisigError("The supplied transaction envelope is not valid XDR.", "InvalidXdr");
  }

  const sendResult = await server.sendTransaction(tx);

  if (sendResult.status === "ERROR") {
    throw new MultisigError(
      `Transaction failed: ${sendResult.errorResult?.toXDR?.("base64") ?? "unknown error"}`,
      "SubmissionFailed",
    );
  }

  const hash = sendResult.hash;
  const success = sdk.rpc.Api?.GetTransactionStatus?.SUCCESS ?? "SUCCESS";
  const failed = sdk.rpc.Api?.GetTransactionStatus?.FAILED ?? "FAILED";

  for (let attempt = 0; attempt < SUBMISSION_POLL_ATTEMPTS; attempt++) {
    await wait(SUBMISSION_POLL_INTERVAL_MS);
    const status = await server.getTransaction(hash);
    if (status.status === success) return { txHash: hash };
    if (status.status === failed) {
      throw new MultisigError("Transaction failed on-chain.", "SubmissionFailed");
    }
  }

  throw new MultisigError("Timed out waiting for the transaction to confirm.", "SubmissionFailed");
}

// ── SEP-0007 deep links ──────────────────────────────────────────────────────

export const SEP0007_TX_SCHEME = "web+stellar:tx";

export interface Sep0007TxParams {
  xdr: string;
  networkPassphrase?: string;
  /** Human readable note shown by the wallet. */
  msg?: string;
  /** URL the signer wallet POSTs the signed XDR back to. */
  callback?: string;
  originDomain?: string;
  pubkey?: string;
  chain?: string;
}

/**
 * Builds a `web+stellar:tx?...` deep link (Stellar SEP-0007) that mobile
 * signer wallets can scan or open directly to import a partial envelope.
 */
export function buildSep0007TxUri(params: Sep0007TxParams): string {
  const search = new URLSearchParams();
  search.set("xdr", params.xdr);
  if (params.networkPassphrase) search.set("network_passphrase", params.networkPassphrase);
  if (params.msg) search.set("msg", params.msg);
  if (params.callback) search.set("callback", params.callback);
  if (params.originDomain) search.set("origin_domain", params.originDomain);
  if (params.pubkey) search.set("pubkey", params.pubkey);
  if (params.chain) search.set("chain", params.chain);
  return `${SEP0007_TX_SCHEME}?${search.toString()}`;
}

/** Parses a SEP-0007 tx URI back into its parameters, or `null` if malformed. */
export function parseSep0007TxUri(uri: string): Sep0007TxParams | null {
  if (!uri || !uri.toLowerCase().startsWith(`${SEP0007_TX_SCHEME}?`)) return null;
  const query = uri.slice(uri.indexOf("?") + 1);
  const search = new URLSearchParams(query);
  const xdr = search.get("xdr");
  if (!xdr) return null;

  return {
    xdr,
    networkPassphrase: search.get("network_passphrase") ?? undefined,
    msg: search.get("msg") ?? undefined,
    callback: search.get("callback") ?? undefined,
    originDomain: search.get("origin_domain") ?? undefined,
    pubkey: search.get("pubkey") ?? undefined,
    chain: search.get("chain") ?? undefined,
  };
}

// ── QR codes ─────────────────────────────────────────────────────────────────

export const DEFAULT_QR_CODE_ENDPOINT = "https://api.qrserver.com/v1/create-qr-code/";

/**
 * Builds a QR image URL for a payload (usually the SEP-0007 URI).
 *
 * The endpoint is configurable via `NEXT_PUBLIC_QR_CODE_ENDPOINT` so operators
 * can self-host the renderer instead of sending signing data to a third party.
 * Only the (non-secret) partial envelope is ever encoded.
 */
export function buildQrCodeUrl(
  payload: string,
  options: { size?: number; endpoint?: string } = {},
): string {
  const endpoint =
    options.endpoint ?? process.env.NEXT_PUBLIC_QR_CODE_ENDPOINT ?? DEFAULT_QR_CODE_ENDPOINT;
  const size = options.size ?? 220;
  const url = new URL(endpoint);
  url.searchParams.set("data", payload);
  url.searchParams.set("size", `${size}x${size}`);
  url.searchParams.set("margin", "0");
  return url.toString();
}

// ── Proposal store (local handoff until the backend relay lands) ─────────────

export type ProposalStatus = "pending" | "submitted" | "failed";

export interface MultisigProposal {
  id: string;
  account: string;
  networkPassphrase: string;
  xdr: string;
  level: ThresholdLevel;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: ProposalStatus;
  signedSigners: string[];
}

export const PROPOSAL_STORAGE_KEY = "flowfi.multisig.proposals.v1";

function readAllProposals(): MultisigProposal[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  const raw = window.localStorage.getItem(PROPOSAL_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is MultisigProposal =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as MultisigProposal).id === "string" &&
        typeof (item as MultisigProposal).xdr === "string",
    );
  } catch {
    return [];
  }
}

function writeAllProposals(proposals: MultisigProposal[]): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem(PROPOSAL_STORAGE_KEY, JSON.stringify(proposals));
}

export function generateProposalId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `mp_${Date.now().toString(36)}_${random}`;
}

export function createProposal(input: {
  account: string;
  xdr: string;
  networkPassphrase: string;
  level?: ThresholdLevel;
  description?: string;
  createdBy: string;
  signedSigners?: string[];
}): MultisigProposal {
  const now = new Date().toISOString();
  return {
    id: generateProposalId(),
    account: input.account,
    xdr: input.xdr,
    networkPassphrase: input.networkPassphrase,
    level: input.level ?? CONTRACT_OPERATION_THRESHOLD_LEVEL,
    description: input.description ?? "Multisig stream transaction",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    signedSigners: input.signedSigners ?? [input.createdBy],
  };
}

export function listProposals(account?: string): MultisigProposal[] {
  const proposals = readAllProposals();
  const filtered = account
    ? proposals.filter((proposal) => proposal.account === account)
    : proposals;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveProposal(proposal: MultisigProposal): void {
  const proposals = readAllProposals();
  const index = proposals.findIndex((existing) => existing.id === proposal.id);
  if (index >= 0) {
    proposals[index] = proposal;
  } else {
    proposals.push(proposal);
  }
  writeAllProposals(proposals);
}

export function updateProposal(
  id: string,
  patch: Partial<Omit<MultisigProposal, "id">>,
): MultisigProposal | null {
  const proposals = readAllProposals();
  const index = proposals.findIndex((proposal) => proposal.id === id);
  const existing = index >= 0 ? proposals[index] : undefined;
  if (!existing) return null;
  const updated: MultisigProposal = {
    ...existing,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  proposals[index] = updated;
  writeAllProposals(proposals);
  return updated;
}

export function deleteProposal(id: string): void {
  writeAllProposals(readAllProposals().filter((proposal) => proposal.id !== id));
}

// ── Envelope export ──────────────────────────────────────────────────────────

/** Triggers a `.xdr` download of a partial envelope for offline handoff. */
export function downloadXdrFile(xdr: string, filename = "flowfi-multisig-tx.xdr"): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([xdr], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
