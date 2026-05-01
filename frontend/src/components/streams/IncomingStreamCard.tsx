"use client";

import React from "react";
import { Button } from "@/components/ui/Button";
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
      return "bg-emerald-500/15 text-emerald-700";
    case "Paused":
      return "bg-amber-500/15 text-amber-700";
    case "Completed":
    default:
      return "bg-slate-500/15 text-slate-700";
  }
}

export function IncomingStreamCard({
  stream,
  withdrawing,
  onWithdraw,
}: IncomingStreamCardProps) {
  const claimable = useStreamingAmount({
    deposited: stream.deposited,
    withdrawn: stream.withdrawn,
    ratePerSecond: stream.ratePerSecond,
    startTime: stream.startTime,
    isActive: stream.isActive,
    isPaused: stream.isPaused,
    pausedAt: stream.pausedAt,
    totalPausedDuration: stream.totalPausedDuration,
  });

  const canWithdraw =
    stream.status === "Active" && claimable > 0 && !withdrawing;

  return (
    <article className="rounded-[1.75rem] border border-white/55 bg-white/80 p-5 shadow-[0_20px_45px_rgba(15,23,42,0.08)] backdrop-blur-sm transition-transform duration-300 hover:-translate-y-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-800/70">
            Incoming stream
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-900">
            {stream.senderDisplay}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Sender
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${badgeClassName(stream.status)}`}
        >
          {stream.status}
        </span>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 text-sm text-slate-600">
        <div className="rounded-2xl bg-slate-900/5 p-4">
          <dt className="text-xs uppercase tracking-[0.16em] text-slate-500">
            Token
          </dt>
          <dd className="mt-2 text-base font-semibold text-slate-900">
            {stream.token}
          </dd>
        </div>
        <div className="rounded-2xl bg-slate-900/5 p-4">
          <dt className="text-xs uppercase tracking-[0.16em] text-slate-500">
            Rate
          </dt>
          <dd className="mt-2 text-base font-semibold text-slate-900">
            {formatTokenAmount(stream.ratePerSecond)} / sec
          </dd>
        </div>
        <div className="col-span-2 rounded-[1.5rem] bg-gradient-to-r from-emerald-500/12 to-sky-500/10 p-4">
          <dt className="text-xs uppercase tracking-[0.16em] text-slate-500">
            Claimable amount
          </dt>
          <dd className="mt-2 text-2xl font-semibold text-slate-900">
            {formatTokenAmount(claimable)} {stream.token}
          </dd>
          <p className="mt-1 text-sm text-slate-500">
            Stream #{stream.streamId}
          </p>
        </div>
      </dl>

      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="text-xs text-slate-500">
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
}
