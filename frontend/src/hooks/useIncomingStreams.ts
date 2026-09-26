"use client";

import {
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchIncomingStreams, type IncomingStreamRecord } from "@/lib/api/streams";
import { logger } from "@/lib/logger";
import {
  withdrawFromStream,
  type SorobanResult,
} from "@/lib/soroban";
import type { WalletSession } from "@/lib/wallet";

export function incomingStreamsQueryKey(publicKey: string | null | undefined) {
  return ["incoming-streams", publicKey] as const;
}

// Current production behavior: no automatic polling. Tests can override this
// via `options.refetchInterval` instead of having to mock timers globally.
const DEFAULT_INCOMING_STREAMS_REFETCH_INTERVAL: number | false = false;

export interface UseIncomingStreamsOptions {
  refetchInterval?: number | false;
}

export function useIncomingStreams(
  publicKey: string | null | undefined,
  options?: UseIncomingStreamsOptions,
) {
  return useQuery({
    queryKey: incomingStreamsQueryKey(publicKey),
    queryFn: () => fetchIncomingStreams(publicKey!),
    enabled: Boolean(publicKey),
    refetchInterval:
      options?.refetchInterval ?? DEFAULT_INCOMING_STREAMS_REFETCH_INTERVAL,
  });
}

export function useWithdrawIncomingStream(
  session: WalletSession | null,
  publicKey: string | null | undefined,
  options?: {
    onSuccess?: (
      result: SorobanResult,
      stream: IncomingStreamRecord,
    ) => Promise<void> | void;
    onError?: (error: unknown, stream: IncomingStreamRecord) => void;
  },
) {
  const queryClient = useQueryClient();

  // Ref to the active poll AbortController so we can cancel on unmount/
  // wallet change. Each mutation resets it.
  const pollControllerRef = useRef<AbortController | null>(null);

  // Abort any in-flight poll when the component unmounts or the wallet
  // changes.  This prevents stale fetches and state writes.
  useEffect(() => {
    return () => {
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
    };
  }, [publicKey]);

  const pollIndexer = useCallback(
    (
      pk: string,
      streamId: number,
      oldWithdrawn: number,
      expectedWithdrawn: number,
    ) => {
      // Abort any previous poll that may still be running
      pollControllerRef.current?.abort();
      const controller = new AbortController();
      pollControllerRef.current = controller;

      pollIndexerForWithdraw(
        pk,
        streamId,
        oldWithdrawn,
        expectedWithdrawn,
        queryClient,
        controller.signal,
      );
    },
    [queryClient],
  );

  return useMutation({
    mutationFn: async (stream: IncomingStreamRecord) => {
      if (!session) {
        throw new Error("Please connect your wallet first");
      }

      return withdrawFromStream(session, {
        streamId: BigInt(stream.streamId),
      });
    },
    onMutate: async (stream) => {
      if (!publicKey) {
        return { previousStreams: undefined, expectedWithdrawn: stream.withdrawn };
      }

      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries({
        queryKey: incomingStreamsQueryKey(publicKey),
      });

      // Snapshot the previous value
      const previousStreams = queryClient.getQueryData<IncomingStreamRecord[]>(
        incomingStreamsQueryKey(publicKey),
      );

      let expectedWithdrawn = stream.withdrawn;

      // Optimistically update the stream in the cache
      if (previousStreams) {
        const nowSeconds = Date.now() / 1000;
        queryClient.setQueryData<IncomingStreamRecord[]>(
          incomingStreamsQueryKey(publicKey),
          previousStreams.map((s) => {
            if (s.id === stream.id) {
              const elapsed = Math.max(0, nowSeconds - s.lastUpdateTime);
              const currentPauseDuration =
                s.isPaused && s.pausedAt ? Math.max(0, nowSeconds - s.pausedAt) : 0;
              const effectiveElapsed = Math.max(0, elapsed - currentPauseDuration);
              const accrued = effectiveElapsed * s.ratePerSecond;
              const maxClaimable = Math.max(0, s.deposited - s.withdrawn);
              const claimable = Math.min(maxClaimable, accrued);

              expectedWithdrawn = s.withdrawn + claimable;

              return {
                ...s,
                withdrawn: expectedWithdrawn,
                lastUpdateTime: nowSeconds,
              };
            }
            return s;
          }),
        );
      }

      return { previousStreams, expectedWithdrawn };
    },
    onSuccess: async (result, stream, context) => {
      if (publicKey) {
        const ctx = context as {
          previousStreams?: IncomingStreamRecord[];
          expectedWithdrawn?: number;
        };
        const targetWithdrawn = ctx.expectedWithdrawn ?? stream.withdrawn;
        // Start polling in the background without blocking the mutation
        pollIndexer(
          publicKey,
          stream.streamId,
          stream.withdrawn,
          targetWithdrawn,
        );
      }

      await options?.onSuccess?.(result, stream);
    },
    onError: (error, stream, context) => {
      const ctx = context as {
        previousStreams?: IncomingStreamRecord[];
        expectedWithdrawn?: number;
      };
      if (publicKey && ctx?.previousStreams) {
        queryClient.setQueryData(
          incomingStreamsQueryKey(publicKey),
          ctx.previousStreams,
        );
      }
      options?.onError?.(error, stream);
    },
  });
}

async function pollIndexerForWithdraw(
  publicKey: string,
  streamId: number,
  oldWithdrawn: number,
  expectedWithdrawn: number,
  queryClient: ReturnType<typeof useQueryClient>,
  signal?: AbortSignal,
  maxRetries = 6,
  initialDelay = 1000,
) {
  let delay = initialDelay;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Stop immediately if the caller has aborted (unmount / wallet change)
    if (signal?.aborted) return;

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Re-check after the delay – the signal may have been aborted while we
    // were waiting.
    if (signal?.aborted) return;

    try {
      const streams = await fetchIncomingStreams(publicKey);
      if (signal?.aborted) return;

      const updatedStream = streams.find((s) => s.streamId === streamId);
      if (
        updatedStream &&
        (updatedStream.withdrawn > oldWithdrawn ||
          updatedStream.withdrawn >= expectedWithdrawn - 0.000001)
      ) {
        queryClient.setQueryData(incomingStreamsQueryKey(publicKey), streams);
        return;
      }
    } catch (err) {
      // AbortError is expected when the signal fires; don't log it as a
      // warning.
      if (signal?.aborted) return;
      logger.warn("Error polling indexer for withdraw:", err);
    }
    delay *= 2;
  }
  if (!signal?.aborted) {
    await queryClient.invalidateQueries({
      queryKey: incomingStreamsQueryKey(publicKey),
    });
  }
}
