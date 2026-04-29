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
    onSuccess: async (result, stream) => {
      if (publicKey) {
        await queryClient.invalidateQueries({
          queryKey: incomingStreamsQueryKey(publicKey),
        });
      }

      await options?.onSuccess?.(result, stream);
    },
    onError: (error, stream) => {
      options?.onError?.(error, stream);
    },
  });
}
