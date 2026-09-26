"use client";

import React from "react";
import { Button } from "@/components/ui/Button";
import { LiveValue } from "@/components/ui/LiveValue";
import { useStreamingAmount } from "@/hooks/useStreamingAmount";
import type {
  IncomingStreamRecord,
  IncomingStreamStatus,
} from "@/lib/api/streams";

interface IncomingStreamCardProps {
  stream: IncomingStreamRecord;
  withdrawing: boolean;
  onWithdraw: (stream: IncomingStreamRecord) => void;
}

function formatTokenAmount(value: number, maximumFractionDigits = 7): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function badgeClassName(status: IncomingStreamStatus): string {
  switch (status) {
    case "Active":
      return "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300";
    case "Paused":
      return "bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300";
    case "Completed":
    default:
      return "bg-slate-500/15 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300";
  }
}

export const IncomingStreamCard = React.memo(function IncomingStreamCard({
  stream,
  withdrawing,
  onWithdraw,
}: IncomingStreamCardProps) {
  const claimable = useStreamingAmount({
    deposited: stream.deposited,
    withdrawn: stream.withdrawn,
    ratePerSecond: stream.ratePerSecond,
    lastUpdateTime: stream.lastUpdateTime,
    isActive: stream.isActive,
    isPaused: stream.isPaused,
    pausedAt: stream.pausedAt,
    totalPausedDuration: stream.totalPausedDuration,
  });

  const canWithdraw =
    stream.status === "Active" && claimable > 0 && !withdrawing;

  return (
    <article
      className="rounded-[1.75rem] border border-white/55 bg-white/80 p-5 shadow-[0_20px_45px_rgba(15,23,42,0.08)] backdrop-blur-sm transition-transform duration-300 hover:-translate-y-1"
      aria-label={`Incoming stream #${stream.streamId} from ${stream.senderDisplay} — ${stream.status}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-800 dark:text-sky-300">
            Incoming stream
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {stream.senderDisplay}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Sender
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${badgeClassName(stream.status)}`}
        >
          {stream.status}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 text-sm text-slate-600 dark:text-slate-400">
        <div className="rounded-2xl bg-slate-900/5 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
            Token
          </p>
          <p className="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100">
            {stream.token}
          </p>
        </div>
        <div className="rounded-2xl bg-slate-900/5 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
            Rate
          </p>
          <p className="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100">
            {formatTokenAmount(stream.ratePerSecond)} / sec
          </p>
        </div>
        <div className="col-span-2 rounded-[1.5rem] bg-gradient-to-r from-emerald-500/12 to-sky-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
            Claimable amount
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {formatTokenAmount(claimable)} {stream.token}
          </p>
          <LiveValue value={`${formatTokenAmount(claimable)} ${stream.token}`} prefix="Claimable amount" />
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Stream #{stream.streamId}
          </p>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="text-xs text-slate-600 dark:text-slate-400">
          {stream.status === "Paused"
            ? "Withdrawals resume once the stream is active again."
            : stream.status === "Completed"
              ? "This stream has finished accruing."
              : "Available balance updates in real time."}
        </div>
        <Button
          onClick={() => onWithdraw(stream)}
          disabled={!canWithdraw}
          loading={withdrawing}
          glow
        >
          {withdrawing ? "Withdrawing..." : "Withdraw"}
        </Button>
      </div>
    </article>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.stream.deposited === nextProps.stream.deposited &&
    prevProps.stream.withdrawn === nextProps.stream.withdrawn &&
    prevProps.stream.ratePerSecond === nextProps.stream.ratePerSecond &&
    prevProps.stream.lastUpdateTime === nextProps.stream.lastUpdateTime &&
    prevProps.stream.isActive === nextProps.stream.isActive &&
    prevProps.stream.isPaused === nextProps.stream.isPaused &&
    prevProps.stream.pausedAt === nextProps.stream.pausedAt &&
    prevProps.stream.totalPausedDuration === nextProps.stream.totalPausedDuration &&
    prevProps.stream.status === nextProps.stream.status &&
    prevProps.withdrawing === nextProps.withdrawing
  );
});
