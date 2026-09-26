/**
 * Shareable stream-invoice links (issue #1331).
 *
 * A recipient configures stream terms, we encode them into a compact,
 * URL-safe base64 token, and the payer opens `/pay?r=<token>` to fund the
 * stream in one click. Encoding/decoding is kept pure and UI-free so it can
 * be unit-tested and used from both the generator modal and the public page.
 */

export interface PaymentRequestParams {
  /** Stellar address that will receive the stream. */
  recipient: string;
  /** Token contract address or symbol the request is denominated in. */
  token: string;
  /** Total requested amount, human-readable decimal string (e.g. "5000"). */
  amount: string;
  /** Stream duration in seconds. */
  durationSeconds: number;
  /** Cliff in seconds before funds begin vesting. Defaults to 0. */
  cliffSeconds?: number;
  /** Optional note / description shown on the invoice. */
  note?: string;
}

/** Query-parameter name carrying the encoded request. */
export const PAYMENT_REQUEST_PARAM = "r";

interface WireFormat {
  v: 1;
  recipient: string;
  token: string;
  amount: string;
  durationSeconds: number;
  cliffSeconds: number;
  note: string;
}

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Encode stream request terms into a URL-safe token. */
export function encodePaymentRequest(params: PaymentRequestParams): string {
  const wire: WireFormat = {
    v: 1,
    recipient: params.recipient,
    token: params.token,
    amount: params.amount,
    durationSeconds: params.durationSeconds,
    cliffSeconds: params.cliffSeconds ?? 0,
    note: params.note ?? "",
  };
  return toBase64Url(JSON.stringify(wire));
}

/** Build the full shareable relative URL for a payment request. */
export function buildPaymentRequestUrl(
  params: PaymentRequestParams,
  basePath = "/pay",
): string {
  return `${basePath}?${PAYMENT_REQUEST_PARAM}=${encodePaymentRequest(params)}`;
}

/**
 * Decode a token produced by {@link encodePaymentRequest}. Returns `null` for
 * anything malformed, unknown-version, or missing a required field — the
 * public page must treat a bad link as "no request" rather than throwing.
 */
export function decodePaymentRequest(
  token: string | null | undefined,
): PaymentRequestParams | null {
  if (!isNonEmptyString(token)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(token));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const wire = parsed as Record<string, unknown>;
  if (wire.v !== 1) return null;
  if (
    !isNonEmptyString(wire.recipient) ||
    !isNonEmptyString(wire.token) ||
    !isNonEmptyString(wire.amount) ||
    typeof wire.durationSeconds !== "number" ||
    !Number.isFinite(wire.durationSeconds) ||
    wire.durationSeconds <= 0
  ) {
    return null;
  }

  const cliffSeconds =
    typeof wire.cliffSeconds === "number" && Number.isFinite(wire.cliffSeconds)
      ? Math.max(0, wire.cliffSeconds)
      : 0;

  return {
    recipient: wire.recipient,
    token: wire.token,
    amount: wire.amount,
    durationSeconds: wire.durationSeconds,
    cliffSeconds,
    note: typeof wire.note === "string" ? wire.note : "",
  };
}

/** Extract and decode a payment request from a URL query string. */
export function decodePaymentRequestFromSearch(
  search: string,
): PaymentRequestParams | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  return decodePaymentRequest(params.get(PAYMENT_REQUEST_PARAM));
}
