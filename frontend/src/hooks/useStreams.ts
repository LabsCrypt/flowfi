'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stream, StreamStatus } from '@/types/analytics';
import { getApiBaseUrl } from '@/lib/api/_shared';
import { TOKEN_ADDRESSES } from '@/lib/soroban';
import { getDefaultTokenDecimals } from '@/utils/amount';

const VALID_STATUSES: StreamStatus[] = ['active', 'paused', 'completed', 'cancelled'];

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBigIntSafe(val: unknown): bigint {
  if (val === null || val === undefined) return 0n;
  try {
    const s = String(val).trim();
    if (!s) return 0n;
    const [whole] = s.split('.');
    return BigInt(whole || '0');
  } catch {
    return 0n;
  }
}

export function getDefaultStreamsEndpoint(): string {
  const base = getApiBaseUrl();
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/streams`;
}

export function normalizeStream(raw: unknown): Stream | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  // Prefer on-chain streamId over database UUID id (issue #1709)
  const onChainId = record.streamId ?? record.stream_id;
  const id =
    onChainId !== undefined && onChainId !== null && String(onChainId).trim() !== ''
      ? str(onChainId)
      : str(record.id);
  if (!id) return null;

  const tokenRecord = (record.token && typeof record.token === 'object'
    ? record.token
    : {}) as Record<string, unknown>;

  const tokenAddress = str(
    tokenRecord.address ?? record.tokenAddress ?? record.token_address,
  );

  // Resolve token symbol: from token object, or matching tokenAddress against known tokens
  let symbol = str(tokenRecord.symbol ?? record.tokenSymbol ?? record.token_symbol);
  if (!symbol && tokenAddress) {
    const knownEntry = Object.entries(TOKEN_ADDRESSES).find(
      ([, addr]) => addr.toLowerCase() === tokenAddress.toLowerCase(),
    );
    if (knownEntry) {
      symbol = knownEntry[0];
    } else {
      symbol = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
    }
  }
  if (!symbol) symbol = 'UNKNOWN';

  // Resolve decimals: explicit decimals take precedence, otherwise default based on symbol (never silent 18)
  const rawDecimals = tokenRecord.decimals ?? record.tokenDecimals ?? record.token_decimals;
  const decimals =
    rawDecimals !== undefined && rawDecimals !== null
      ? num(rawDecimals, getDefaultTokenDecimals(symbol))
      : getDefaultTokenDecimals(symbol);

  // Timestamps: map REST startTime / endTime without zero dates
  const startTimestamp = num(
    record.startTimestamp ??
      record.start_timestamp ??
      record.startTime ??
      record.start_time,
  );

  const endTimestamp = num(
    record.endTimestamp ??
      record.end_timestamp ??
      record.endTime ??
      record.end_time,
  );

  const cliffTimestamp = num(
    record.cliffTimestamp ??
      record.cliff_timestamp ??
      record.cliffTime ??
      record.cliff_time,
  );

  const lastActionLedger = num(
    record.lastActionLedger ??
      record.last_action_ledger ??
      record.lastLedger ??
      record.last_ledger,
  );

  const createdAt = str(
    record.createdAt ??
      record.created_at ??
      (startTimestamp > 0
        ? new Date(startTimestamp * 1000).toISOString()
        : new Date().toISOString()),
  );

  // Status mapping: support explicit string as well as REST boolean flags isActive and isPaused
  let status: StreamStatus;
  const rawStatus = typeof record.status === 'string' ? record.status.toLowerCase().trim() : '';
  if (VALID_STATUSES.includes(rawStatus as StreamStatus)) {
    status = rawStatus as StreamStatus;
  } else {
    const isPaused = Boolean(record.isPaused ?? record.is_paused);
    const isActive =
      record.isActive !== undefined
        ? Boolean(record.isActive)
        : record.is_active !== undefined
          ? Boolean(record.is_active)
          : true;

    if (isPaused) {
      status = 'paused';
    } else if (isActive) {
      status = 'active';
    } else {
      const events = Array.isArray(record.events) ? record.events : [];
      const wasCancelled = events.some(
        (e: unknown) =>
          typeof e === 'object' &&
          e !== null &&
          (
            (e as Record<string, unknown>).eventType === 'CANCELLED' ||
            (e as Record<string, unknown>).type === 'CANCELLED' ||
            (e as Record<string, unknown>).type === 'cancelled'
          ),
      );
      status = wasCancelled ? 'cancelled' : 'completed';
    }
  }

  const depositedAmount = str(record.depositedAmount ?? record.deposited_amount ?? '0');
  const withdrawnAmount = str(record.withdrawnAmount ?? record.withdrawn_amount ?? '0');

  let remainingBalance = str(record.remainingBalance ?? record.remaining_balance);
  if (!remainingBalance) {
    const dep = parseBigIntSafe(depositedAmount);
    const withdr = parseBigIntSafe(withdrawnAmount);
    remainingBalance = dep >= withdr ? (dep - withdr).toString() : '0';
  }

  const claimableBalance = str(record.claimableBalance ?? record.claimable_balance ?? '0');

  return {
    id,
    createdAt,
    sender: str(record.sender ?? record.senderAddress ?? record.sender_address),
    recipient: str(record.recipient ?? record.recipientAddress ?? record.recipient_address),
    memo: record.memo ? str(record.memo) : undefined,
    token: {
      symbol,
      address: tokenAddress,
      decimals,
      logoURI: tokenRecord.logoURI
        ? str(tokenRecord.logoURI)
        : record.tokenLogo
          ? str(record.tokenLogo)
          : undefined,
    },
    depositedAmount,
    withdrawnAmount,
    remainingBalance,
    claimableBalance,
    startTimestamp,
    endTimestamp,
    cliffTimestamp,
    status,
    lastActionLedger,
    usdRate: record.usdRate !== undefined ? num(record.usdRate, 0) : undefined,
  };
}

export function normalizeStreams(raw: unknown): Stream[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.data)
      ? ((raw as Record<string, unknown>).data as unknown[])
      : Array.isArray((raw as Record<string, unknown>)?.streams)
        ? ((raw as Record<string, unknown>).streams as unknown[])
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
  const defaultEndpoint = getDefaultStreamsEndpoint();
  const {
    refreshInterval = 30_000,
    address,
    endpoint = defaultEndpoint,
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
        const url = new URL(
          endpoint,
          typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
        );
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
