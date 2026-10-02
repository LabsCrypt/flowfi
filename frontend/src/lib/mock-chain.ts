/**
 * lib/mock-chain.ts
 *
 * Client half of the one-click mock sandbox (`npm run dev:mock`, issue #1336).
 *
 * When NEXT_PUBLIC_MOCK_MODE=true, the app signs in with one of the seeded
 * sandbox accounts instead of a browser wallet, and every "on-chain" action is
 * applied by the backend's /v1/mock/* routes instead of being signed and
 * broadcast to Soroban. Nothing here is reachable unless the flag is set, and
 * the backend refuses to serve those routes unless it was started with
 * MOCK_MODE=true outside production.
 */

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api/_shared";

export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_MODE === "true";

export interface MockAccount {
  publicKey: string;
  label: string;
}

interface MockActionResponse {
  success: true;
  mock: true;
  txHash: string;
  streamId: string;
  streamIds?: string[];
  amount?: string;
}

/** Machine-readable failure classes the backend reports for mock actions. */
export type MockErrorCode =
  | "stream_not_found"
  | "forbidden"
  | "conflict"
  | "invalid_params"
  | "invalid_action"
  | "invalid_rate";

/** Thrown for any mock-mode API rejection; callers map this to a UI message. */
export class MockActionError extends Error {
  constructor(
    message: string,
    readonly code: MockErrorCode | string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MockActionError";
  }
}

async function parseError(response: Response): Promise<MockActionError> {
  let message = `Mock sandbox request failed (${response.status})`;
  let code = "unknown";
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string } | string;
    };
    const error = typeof body.error === "string" ? { message: body.error } : body.error;
    if (error?.message) message = error.message;
    if (error?.code) code = error.code;
  } catch {
    // Keep the status-based message.
  }
  return new MockActionError(message, code, response.status);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Fetch (and memoise) a sandbox session token for an account. The token is
 * valid for 24h server-side, so the in-memory cache only guards against
 * re-fetching on every action.
 */
export async function fetchMockToken(publicKey: string): Promise<string> {
  const cached = tokenCache.get(publicKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetchWithTimeout(`${getApiBaseUrl()}/v1/mock/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });

  if (!response.ok) throw await parseError(response);

  const body = (await response.json()) as { token: string; expiresIn: number };
  tokenCache.set(publicKey, {
    token: body.token,
    expiresAt: Date.now() + body.expiresIn * 1000 - 60_000,
  });
  return body.token;
}

/** List the seeded sandbox accounts a contributor can sign in as. */
export async function fetchMockAccounts(): Promise<MockAccount[]> {
  const response = await fetchWithTimeout(`${getApiBaseUrl()}/v1/mock/users`);
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { users: MockAccount[] };
  return body.users;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new MockActionError(`Expected a numeric value, received ${typeof value}`, "invalid_params", 0);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  throw new MockActionError(`Expected a string value, received ${typeof value}`, "invalid_params", 0);
}

async function postAction(
  publicKey: string,
  action: string,
  params: Record<string, unknown>,
): Promise<MockActionResponse> {
  const token = await fetchMockToken(publicKey);
  const response = await fetchWithTimeout(`${getApiBaseUrl()}/v1/mock/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, params }),
  });

  if (!response.ok) throw await parseError(response);
  return (await response.json()) as MockActionResponse;
}

/**
 * Apply a contract action locally.
 *
 * Mirrors the argument order each `freighterCall` wrapper in lib/soroban.ts
 * builds, after decoding the ScVals through `scValToNative`.
 */
export async function mockContractCall(
  publicKey: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
): Promise<{ success: true; txHash: string }> {
  const { scValToNative } = await import("@stellar/stellar-sdk");
  const native = args.map((arg) => scValToNative(arg));

  switch (method) {
    case "create_stream": {
      const [, recipient, tokenAddress, amount, duration] = native;
      return postAction(publicKey, "create_stream", {
        recipient: toStringValue(recipient),
        tokenAddress: toStringValue(tokenAddress),
        amount: toBigInt(amount).toString(),
        duration: Number(toBigInt(duration)),
      });
    }

    case "top_up_stream": {
      const [, streamId, amount] = native;
      return postAction(publicKey, "top_up_stream", {
        streamId: toBigInt(streamId).toString(),
        amount: toBigInt(amount).toString(),
      });
    }

    case "batch_withdraw": {
      const [streamIds] = native;
      const ids = (Array.isArray(streamIds) ? streamIds : [streamIds]).map((id) =>
        toBigInt(id).toString(),
      );
      return postAction(publicKey, "batch_withdraw", { streamIds: ids });
    }

    case "withdraw":
    case "cancel_stream":
    case "pause_stream":
    case "resume_stream": {
      const [, streamId] = native;
      return postAction(publicKey, method, { streamId: toBigInt(streamId).toString() });
    }

    default:
      throw new MockActionError(`Unsupported mock action: ${method}`, "invalid_action", 400);
  }
}

/**
 * Deterministic sandbox token balance.
 *
 * The create-stream flow checks the sender's balance before building a
 * transaction. Offline there is no token contract to read, so every account
 * gets a fixed, comfortably large balance.
 */
export function mockTokenBalance(publicKey: string, tokenSymbol: string): bigint {
  const seed = Array.from(`${publicKey}:${tokenSymbol}`).reduce(
    (acc, char) => (acc * 31 + char.charCodeAt(0)) % 1_000_000,
    7,
  );
  return BigInt(500_000 + seed) * 10_000_000n; // ≥ 50,000 tokens at 7 decimals
}