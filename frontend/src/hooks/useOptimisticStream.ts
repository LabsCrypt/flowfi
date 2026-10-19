'use client';

import { useCallback, useMemo, useState } from 'react';
import { useStreamContext } from '@/context/StreamContext';
import type { CachedStream, MutationKind, OptimisticMutation } from '@/lib/storage/stream-cache';

export interface CommitContext {
  streamId: string;
  kind: MutationKind;
  amount?: string;
}

export interface CommitResult {
  txHash?: string;
  stream?: CachedStream;
}

export interface UseOptimisticStreamOptions {
  commit?: (ctx: CommitContext) => Promise<CommitResult>;
  onError?: (message: string) => void;
}

export interface UseOptimisticStreamResult {
  stream: CachedStream | undefined;
  isPending: boolean;
  pendingMutations: OptimisticMutation[];
  error: string | null;
  withdraw: (amount: string) => Promise<void>;
  topUp: (amount: string) => Promise<void>;
  cancel: () => Promise<void>;
  pause: () => Promise<void>;
}

function addAmounts(a: string, b: string): string {
  try { return (BigInt(a) + BigInt(b)).toString(); } catch { return a; }
}

function subAmounts(a: string, b: string): string {
  try {
    const result = BigInt(a) - BigInt(b);
    return result < 0n ? '0' : result.toString();
  } catch { return a; }
}

function makeMutationId(): string {
  return `mut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useOptimisticStream(
  streamId: string,
  options: UseOptimisticStreamOptions = {},
): UseOptimisticStreamResult {
  const ctx = useStreamContext();
  const [error, setError] = useState<string | null>(null);

  const stream = ctx.getStream(streamId);
  const pendingMutations = useMemo(
    () => ctx.mutations.filter((m) => m.streamId === streamId && m.status === 'pending'),
    [ctx.mutations, streamId],
  );
  const isPending = pendingMutations.length > 0;

  const run = useCallback(
    async (
      kind: MutationKind,
      patch: Partial<CachedStream>,
      before: Partial<CachedStream>,
      amount?: string,
    ) => {
      if (!stream) return;
      setError(null);

      const mutation: OptimisticMutation = {
        id: makeMutationId(),
        streamId,
        kind,
        createdAt: Date.now(),
        status: 'pending',
        before,
        patch,
      };

      await ctx.applyOptimistic(mutation);

      try {
        const result = options.commit
          ? await options.commit({ streamId, kind, amount })
          : ({} as CommitResult);

        if (result.stream) {
          // Canonical record returned — reconcile silently.
          ctx.upsertStreams([result.stream]);
        } else {
          // No canonical record yet — fold the optimistic patch into the
          // cache so the UI keeps the new value until the indexer catches up.
          ctx.upsertStreams([{ ...stream, ...patch }]);
        }
        await ctx.resolveMutation(mutation.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transaction failed';
        await ctx.rollbackMutation(mutation.id);
        setError(message);
        options.onError?.(message);
      }
    },
    [ctx, options, stream, streamId],
  );

  const withdraw = useCallback(
    async (amount: string) => {
      if (!stream) return;
      await run(
        'WITHDRAW',
        {
          withdrawnAmount: addAmounts(stream.withdrawnAmount, amount),
          claimableAmount: subAmounts(stream.claimableAmount, amount),
          updatedAt: Date.now(),
        },
        {
          withdrawnAmount: stream.withdrawnAmount,
          claimableAmount: stream.claimableAmount,
        },
        amount,
      );
    },
    [run, stream],
  );

  const topUp = useCallback(
    async (amount: string) => {
      if (!stream) return;
      await run(
        'TOP_UP',
        {
          depositedAmount: addAmounts(stream.depositedAmount, amount),
          updatedAt: Date.now(),
        },
        { depositedAmount: stream.depositedAmount },
        amount,
      );
    },
    [run, stream],
  );

  const cancel = useCallback(async () => {
    if (!stream) return;
    await run('CANCEL', { status: 'cancelled', updatedAt: Date.now() }, { status: stream.status });
  }, [run, stream]);

  const pause = useCallback(async () => {
    if (!stream) return;
    await run('PAUSE', { status: 'paused', updatedAt: Date.now() }, { status: stream.status });
  }, [run, stream]);

  return { stream, isPending, pendingMutations, error, withdraw, topUp, cancel, pause };
}

export default useOptimisticStream;
