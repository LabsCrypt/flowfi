'use client';

import { useEffect, useState } from 'react';
import type { FlowFiStream } from '../types';
import { useFlowFiConfig } from '../components/FlowFiProvider';

export interface UseStreamResult {
  stream: FlowFiStream | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useStream(streamId: string | undefined, endpoint = '/api/v1/streams'): UseStreamResult {
  const { rpcUrl } = useFlowFiConfig();
  const [stream, setStream] = useState<FlowFiStream | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!streamId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const url = rpcUrl ? `${endpoint}?id=${streamId}` : `${endpoint}/${streamId}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setStream(json?.stream ?? json ?? null);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error('Failed to load stream'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streamId, endpoint, rpcUrl, nonce]);

  return { stream, isLoading, error, refetch: () => setNonce((n) => n + 1) };
}
