"use client";

import React from "react";
import toast from "react-hot-toast";
import TransactionTracker, {
  type TransactionStatus,
} from "@/components/TransactionTracker";
import { IncomingStreamCard } from "@/components/streams/IncomingStreamCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWallet } from "@/context/wallet-context";
import {
  type IncomingStreamRecord,
} from "@/lib/api/streams";
import { toSorobanErrorMessage } from "@/lib/soroban";
import {
  useIncomingStreams,
  useWithdrawIncomingStream,
} from "@/hooks/useIncomingStreams";

interface TrackerState {
  status: TransactionStatus;
  txHash?: string;
  error?: string;
  streamId?: string;
}

function LoadingCard() {
  return (
    <div className="rounded-[1.75rem] border border-white/45 bg-white/75 p-5 shadow-[0_20px_45px_rgba(15,23,42,0.06)]">
      <Skeleton className="h-4 w-28 rounded-full bg-slate-200/80" />
      <Skeleton className="mt-4 h-7 w-40 rounded-xl bg-slate-200/80" />
      <div className="mt-6 grid grid-cols-2 gap-4">
        <Skeleton className="h-24 rounded-[1.25rem] bg-slate-200/80" />
        <Skeleton className="h-24 rounded-[1.25rem] bg-slate-200/80" />
        <Skeleton className="col-span-2 h-28 rounded-[1.5rem] bg-slate-200/80" />
      </div>
      <Skeleton className="mt-6 h-11 w-32 rounded-full bg-slate-200/80" />
    </div>
  );
}

export default function IncomingPage() {
  const { session, status, isHydrated } = useWallet();
  const [tracker, setTracker] = React.useState<TrackerState>({
    status: "idle",
  });

  const incomingStreamsQuery = useIncomingStreams(session?.publicKey);
  const withdrawMutation = useWithdrawIncomingStream(
    session,
    session?.publicKey,
    {
      onSuccess: async (result, stream) => {
        setTracker({
          status: "submitted",
          txHash: result.txHash,
          streamId: String(stream.streamId),
        });
        toast.success(`Withdrawal submitted for stream #${stream.streamId}`);

        window.setTimeout(() => {
          setTracker((current) =>
            current.txHash === result.txHash
              ? { ...current, status: "confirmed" }
              : current,
          );
        }, 1500);
      },
      onError: (error, stream) => {
        const message = toSorobanErrorMessage(error);
        setTracker({
          status: "failed",
          error: message,
          streamId: String(stream.streamId),
        });
        toast.error(message);
      },
    },
  );

  const handleWithdraw = async (stream: IncomingStreamRecord) => {
    setTracker({
      status: "signing",
      streamId: String(stream.streamId),
    });

    try {
      await withdrawMutation.mutateAsync(stream);
    } catch {
      // Errors are handled by the mutation callback so the UI stays consistent.
    }
  };

  const isLoading =
    !isHydrated ||
    (status === "connected" && incomingStreamsQuery.isLoading);
  const streams = incomingStreamsQuery.data ?? [];

  return (
    <main className="px-4 py-10 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-7xl">
        <div className="rounded-[2rem] border border-white/45 bg-white/70 px-6 py-8 shadow-[0_30px_60px_rgba(15,23,42,0.08)] backdrop-blur-sm sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-800/70">
            Incoming funds
          </p>
          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                Streams paying into your wallet
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
                Review every active payment stream you receive, keep an eye on live accrual,
                and withdraw funds the moment they become claimable.
              </p>
            </div>
            {status === "connected" && session?.publicKey && (
              <div className="rounded-2xl bg-slate-950/5 px-4 py-3 text-sm text-slate-600">
                Recipient wallet
                <div className="mt-1 font-mono text-xs text-slate-900">
                  {session.publicKey}
                </div>
              </div>
            )}
          </div>
        </div>

        {!isHydrated ? (
          <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <LoadingCard />
            <LoadingCard />
            <LoadingCard />
          </section>
        ) : status !== "connected" ? (
          <section className="mt-8 rounded-[2rem] border border-white/45 bg-white/75 p-10 text-center shadow-[0_24px_50px_rgba(15,23,42,0.07)]">
            <h2 className="text-2xl font-semibold text-slate-950">
              Connect a wallet to view incoming streams
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-600">
              Once your wallet is connected, this page will automatically load every stream
              where you are the recipient and keep the claimable balance fresh.
            </p>
          </section>
        ) : incomingStreamsQuery.isError ? (
          <section className="mt-8 rounded-[2rem] border border-rose-200 bg-rose-50/80 p-8 shadow-[0_18px_36px_rgba(190,24,93,0.08)]">
            <h2 className="text-xl font-semibold text-rose-900">
              We couldn&apos;t load your incoming streams
            </h2>
            <p className="mt-2 text-sm text-rose-700">
              {incomingStreamsQuery.error instanceof Error
                ? incomingStreamsQuery.error.message
                : "Please try again in a moment."}
            </p>
          </section>
        ) : isLoading ? (
          <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <LoadingCard />
            <LoadingCard />
            <LoadingCard />
          </section>
        ) : streams.length === 0 ? (
          <section className="mt-8 rounded-[2rem] border border-white/45 bg-white/75 p-10 text-center shadow-[0_24px_50px_rgba(15,23,42,0.07)]">
            <h2 className="text-2xl font-semibold text-slate-950">
              No incoming streams yet
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-600">
              When someone starts streaming funds to this wallet, the stream will show up here
              with its current claimable balance and a withdraw action.
            </p>
          </section>
        ) : (
          <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {streams.map((stream) => (
              <IncomingStreamCard
                key={stream.id}
                stream={stream}
                withdrawing={
                  withdrawMutation.isPending &&
                  withdrawMutation.variables?.streamId === stream.streamId
                }
                onWithdraw={(selectedStream) => {
                  void handleWithdraw(selectedStream);
                }}
              />
            ))}
          </section>
        )}

        {tracker.status !== "idle" && (
          <section className="mt-8 rounded-[2rem] border border-slate-900/8 bg-slate-950 px-6 py-5 text-white shadow-[0_22px_45px_rgba(15,23,42,0.18)]">
            <TransactionTracker
              status={tracker.status}
              action="withdraw"
              txHash={tracker.txHash}
              error={tracker.error}
              streamId={tracker.streamId}
            />
          </section>
        )}
      </section>
    </main>
  );
}
