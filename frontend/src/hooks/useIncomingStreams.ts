"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchIncomingStreams, type IncomingStreamRecord } from "@/lib/api/streams";
import {
  withdrawFromStream,
  type SorobanResult,
} from "@/lib/soroban";
import type { WalletSession } from "@/lib/wallet";

export function incomingStreamsQueryKey(publicKey: string | null | undefined) {
  return ["incoming-streams", publicKey] as const;
}

export function useIncomingStreams(publicKey: string | null | undefined) {
  return useQuery({
    queryKey: incomingStreamsQueryKey(publicKey),
    queryFn: () => fetchIncomingStreams(publicKey!),
    enabled: Boolean(publicKey),
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
      if (!publicKey) return;

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
    onSuccess: async (result, stream, _variables, context) => {
      if (publicKey) {
        const targetWithdrawn = context?.expectedWithdrawn ?? stream.withdrawn;
        // Start polling in the background without blocking the mutation
        pollIndexerForWithdraw(
          publicKey,
          stream.streamId,
          stream.withdrawn,
          targetWithdrawn,
          queryClient,
        );
      }

      await options?.onSuccess?.(result, stream);
    },
    onError: (error, stream, context) => {
      if (publicKey && context?.previousStreams) {
        queryClient.setQueryData(
          incomingStreamsQueryKey(publicKey),
          context.previousStreams,
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
  maxRetries = 6,
  initialDelay = 1000,
) {
  let delay = initialDelay;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const streams = await fetchIncomingStreams(publicKey);
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
      console.warn("Error polling indexer for withdraw:", err);
    }
    delay *= 2;
  }
  await queryClient.invalidateQueries({
    queryKey: incomingStreamsQueryKey(publicKey),
  });
}
