'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stream, StreamStatus } from '@/types/analytics';

const VALID_STATUSES: StreamStatus[] = ['active', 'paused', 'completed', 'cancelled'];

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeStream(raw: unknown): Stream | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const id = str(record.id ?? record.streamId ?? record.stream_id);
  if (!id) return null;

  const tokenRecord = (record.token ?? {}) as Record<string, unknown>;
  const status = str(record.status, 'active') as StreamStatus;

  return {
    id,
    createdAt: str(record.createdAt ?? record.created_at ?? new Date().toISOString()),
    sender: str(record.sender ?? record.senderAddress ?? record.sender_address),
    recipient: str(record.recipient ?? record.recipientAddress ?? record.recipient_address),
    memo: record.memo ? str(record.memo) : undefined,
    token: {
      symbol: str(tokenRecord.symbol ?? record.tokenSymbol ?? record.token_symbol, 'UNKNOWN'),
      address: str(tokenRecord.address ?? record.tokenAddress ?? record.token_address),
      decimals: num(tokenRecord.decimals ?? record.tokenDecimals ?? record.token_decimals, 18),
      logoURI: tokenRecord.logoURI
        ? str(tokenRecord.logoURI)
        : record.tokenLogo
          ? str(record.tokenLogo)
          : undefined,
    },
    depositedAmount: str(record.depositedAmount ?? record.deposited_amount ?? '0'),
    withdrawnAmount: str(record.withdrawnAmount ?? record.withdrawn_amount ?? '0'),
    remainingBalance: str(record.remainingBalance ?? record.remaining_balance ?? '0'),
    claimableBalance: str(record.claimableBalance ?? record.claimable_balance ?? '0'),
    startTimestamp: num(record.startTimestamp ?? record.start_timestamp),
    endTimestamp: num(record.endTimestamp ?? record.end_timestamp),
    cliffTimestamp: num(record.cliffTimestamp ?? record.cliff_timestamp),
    status: VALID_STATUSES.includes(status) ? status : 'active',
    lastActionLedger: num(record.lastActionLedger ?? record.last_action_ledger),
    usdRate: record.usdRate !== undefined ? num(record.usdRate, 0) : undefined,
  };
}

export function normalizeStreams(raw: unknown): Stream[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.streams)
      ? ((raw as Record<string, unknown>).streams as unknown[])
      : Array.isArray((raw as Record<string, unknown>)?.data)
        ? ((raw as Record<string, unknown>).data as unknown[])
        : [];

  return list
    .map(normalizeStream)
    .filter((stream): stream is Stream => stream !== null);
}

export interface UseStreamsOptions {
  refreshInterval?: number;
  address?: string;
  endpoint?: string;
  enabled?: boolean;
}

export interface UseStreamsResult {
  streams: Stream[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useStreams(options: UseStreamsOptions = {}): UseStreamsResult {
  const {
    refreshInterval = 30_000,
    address,
    endpoint = '/api/streams',
    enabled = true,
  } = options;

  const [streams, setStreams] = useState<Stream[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const load = async (showSpinner: boolean) => {
      if (showSpinner) setIsLoading(true);
      try {
        const url = new URL(endpoint, window.location.origin);
        if (address) url.searchParams.set('address', address);

        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Failed to load streams (${response.status})`);
        }

        const payload = await response.json();
        if (cancelled) return;
        setStreams(normalizeStreams(payload));
        setError(null);
      } catch (caught) {
        if (cancelled || (caught as Error)?.name === 'AbortError') return;
        setError(caught instanceof Error ? caught : new Error('Failed to load streams'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load(true);

    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (refreshInterval > 0) {
      intervalId = setInterval(() => void load(false), refreshInterval);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (intervalId) clearInterval(intervalId);
    };
  }, [address, endpoint, enabled, refreshInterval, nonce]);

  return { streams, isLoading, error, refresh };
}
