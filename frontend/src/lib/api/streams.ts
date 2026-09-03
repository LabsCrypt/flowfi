import type { BackendStream } from "@/lib/api-types";
import { TOKEN_ADDRESSES, resolveTokenSymbol } from "@/lib/soroban";
import { shortenPublicKey } from "@/lib/wallet";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  getStreamsEndpointCandidates,
  toTokenAmount,
} from "@/lib/api/_shared";

export type IncomingStreamStatus = "Active" | "Paused" | "Completed";

export interface IncomingStreamRecord {
  id: string;
  streamId: number;
  sender: string;
  senderDisplay: string;
  token: string;
  tokenAddress: string;
  ratePerSecond: number;
  deposited: number;
  withdrawn: number;
  startTime: number;
  lastUpdateTime: number;
  isActive: boolean;
  isPaused: boolean;
  pausedAt: number | null;
  totalPausedDuration: number;
  status: IncomingStreamStatus;
}

interface StreamListResponse {
  data?: BackendStream[];
}

function toIncomingStreamStatus(stream: BackendStream): IncomingStreamStatus {
  if (stream.isPaused) return "Paused";
  if (stream.isActive) return "Active";
  return "Completed";
}

function mapBackendStream(stream: BackendStream): IncomingStreamRecord {
  return {
    id: stream.id,
    streamId: stream.streamId,
    sender: stream.sender,
    senderDisplay: shortenPublicKey(stream.sender),
    token: resolveTokenSymbol(stream.tokenAddress),
    tokenAddress: stream.tokenAddress,
    ratePerSecond: toTokenAmount(stream.ratePerSecond),
    deposited: toTokenAmount(stream.depositedAmount),
    withdrawn: toTokenAmount(stream.withdrawnAmount),
    startTime: stream.startTime,
    lastUpdateTime: stream.lastUpdateTime,
    isActive: stream.isActive,
    isPaused: stream.isPaused ?? false,
    pausedAt: stream.pausedAt ?? null,
    totalPausedDuration: stream.totalPausedDuration ?? 0,
    status: toIncomingStreamStatus(stream),
  };
}

export async function fetchIncomingStreams(
  recipientPublicKey: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<IncomingStreamRecord[]> {
  const endpoints = getStreamsEndpointCandidates();
  const params = new URLSearchParams({
    recipient: recipientPublicKey,
    sort: "lastUpdateTime",
    order: "desc",
    limit: "100",
  });
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const response = await fetchWithTimeout(`${endpoint}?${params.toString()}`, {}, timeoutMs);

    if (response.ok) {
      const payload = (await response.json()) as BackendStream[] | StreamListResponse;
      const streams = Array.isArray(payload) ? payload : payload.data ?? [];
      return streams.map(mapBackendStream);
    }

    if (response.status === 404) {
      lastError = new Error(`Endpoint not found: ${endpoint}`);
      continue;
    }

    lastError = new Error(
      `Failed to fetch incoming streams (${response.status}) from ${endpoint}`,
    );
  }

  throw lastError ?? new Error("Failed to fetch incoming streams from backend.");
}
