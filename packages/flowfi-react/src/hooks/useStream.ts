'use client';

import { useEffect, useState } from 'react';
import type { FlowFiStream } from '../types';

export interface UseStreamResult {
  stream: FlowFiStream | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Maps a backend stream response (from GET /api/v1/streams/:streamId) into a FlowFiStream.
 */
export function mapBackendStreamToFlowFiStream(raw: unknown): FlowFiStream | null {
  if (!raw || typeof raw !== 'object') return null;

  const data = ('stream' in raw && raw.stream && typeof raw.stream === 'object'
    ? raw.stream
    : 'data' in raw && raw.data && typeof raw.data === 'object'
      ? raw.data
      : raw) as Record<string, unknown>;

  const id = String(data.streamId ?? data.id ?? '');
  if (!id) return null;

  const sender = String(data.sender ?? '');
  const recipient = String(data.recipient ?? '');

  const rawToken =
    data.token && typeof data.token === 'object'
      ? (data.token as Record<string, unknown>)
      : null;

  const token = {
    symbol: String(rawToken?.symbol ?? data.tokenSymbol ?? 'TOKEN'),
    address: String(rawToken?.address ?? data.tokenAddress ?? ''),
    decimals: Number(rawToken?.decimals ?? data.tokenDecimals ?? 7),
  };

  const depositedAmount = String(data.depositedAmount ?? '0');
  const withdrawnAmount = String(data.withdrawnAmount ?? '0');

  let remainingBalance =
    typeof data.remainingBalance === 'string' ? data.remainingBalance : '';
  if (!remainingBalance) {
    try {
      const dep = BigInt(depositedAmount.split('.')[0] || '0');
      const wth = BigInt(withdrawnAmount.split('.')[0] || '0');
      remainingBalance = dep >= wth ? (dep - wth).toString() : '0';
    } catch {
      remainingBalance = '0';
    }
  }

  const claimableBalance =
    typeof data.claimableBalance === 'string'
      ? data.claimableBalance
      : typeof data.claimableAmount === 'string'
        ? data.claimableAmount
        : '0';

  const startTimestamp = Number(data.startTimestamp ?? data.startTime ?? 0);
  let endTimestamp = Number(data.endTimestamp ?? data.endTime ?? 0);
  if (!endTimestamp && data.ratePerSecond && data.ratePerSecond !== '0') {
    try {
      const rate = BigInt(String(data.ratePerSecond).split('.')[0] || '0');
      const dep = BigInt(depositedAmount.split('.')[0] || '0');
      if (rate > 0n) {
        endTimestamp = startTimestamp + Number(dep / rate);
      }
    } catch {
      // ignore
    }
  }

  const cliffTimestamp = Number(
    data.cliffTimestamp ?? data.cliffDate ?? data.cliffTime ?? 0,
  );

  let status: FlowFiStream['status'] = 'active';
  if (typeof data.status === 'string') {
    const s = data.status.toLowerCase();
    if (s === 'active' || s === 'paused' || s === 'completed' || s === 'cancelled') {
      status = s;
    }
  } else if (data.isPaused) {
    status = 'paused';
  } else if (data.isCancelled) {
    status = 'cancelled';
  } else if (data.isActive === false) {
    status = 'completed';
  }

  const usdRate = data.usdRate !== undefined ? Number(data.usdRate) : undefined;

  return {
    id,
    sender,
    recipient,
    token,
    depositedAmount,
    withdrawnAmount,
    remainingBalance,
    claimableBalance,
    startTimestamp,
    endTimestamp,
    cliffTimestamp,
    status,
    ...(usdRate !== undefined ? { usdRate } : {}),
  };
}

export function useStream(
  streamId: string | undefined,
  endpoint = '/api/v1/streams',
): UseStreamResult {
  const [stream, setStream] = useState<FlowFiStream | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!streamId) {
      setStream(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setStream(null);

    void (async () => {
      try {
        let cleanEndpoint = endpoint;
        while (cleanEndpoint.endsWith('/')) {
          cleanEndpoint = cleanEndpoint.slice(0, -1);
        }
        const url = `${cleanEndpoint}/${encodeURIComponent(streamId)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });

        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            const errorBody = await res.json();
            if (errorBody?.error?.message) {
              message = errorBody.error.message;
            } else if (errorBody?.message) {
              message = errorBody.message;
            }
          } catch {
            // ignore non-JSON error body
          }
          if (res.status === 404 && !message.toLowerCase().includes('not found')) {
            message = `Stream not found (${message})`;
          }
          throw new Error(message);
        }

        const json = await res.json();
        if (!cancelled) {
          const mapped = mapBackendStreamToFlowFiStream(json);
          setStream(mapped);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setStream(null);
          setError(err instanceof Error ? err : new Error('Failed to load stream'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [streamId, endpoint, nonce]);

  return { stream, isLoading, error, refetch: () => setNonce((n) => n + 1) };
}
