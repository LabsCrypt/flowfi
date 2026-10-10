'use client';

import {
  useOptimisticStream,
  type CommitContext,
  type CommitResult,
} from '@/hooks/useOptimisticStream';

export interface StreamCardProps {
  streamId: string;
  commit?: (ctx: CommitContext) => Promise<CommitResult>;
  onError?: (message: string) => void;
}

function formatAmount(raw: string, decimals: number): string {
  try {
    const value = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = value % base;
    if (fraction === 0n) return whole.toString();
    const frac = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return raw;
  }
}

export function StreamCard({ streamId, commit, onError }: StreamCardProps) {
  const { stream, isPending, error, withdraw, topUp, cancel, pause } = useOptimisticStream(
    streamId,
    { commit, onError },
  );

  if (!stream) {
    return (
      <article
        data-testid="stream-skeleton"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <p className="text-sm text-slate-500">Loading stream…</p>
      </article>
    );
  }

  return (
    <article
      data-testid={`stream-card-${stream.id}`}
      data-pending={isPending}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
            {stream.tokenSymbol} stream
          </h3>
          <p className="truncate font-mono text-[10px] text-slate-500">{stream.id}</p>
        </div>

        {isPending ? (
          <span
            data-testid="pending-badge"
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            Pending Ledger Confirmation
          </span>
        ) : null}
      </header>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-slate-500">Deposited</dt>
          <dd data-testid="stream-deposited" className="tabular-nums text-slate-800 dark:text-slate-100">
            {formatAmount(stream.depositedAmount, stream.tokenDecimals)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Withdrawn</dt>
          <dd data-testid="stream-withdrawn" className="tabular-nums text-slate-800 dark:text-slate-100">
            {formatAmount(stream.withdrawnAmount, stream.tokenDecimals)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Claimable</dt>
          <dd data-testid="stream-claimable" className="tabular-nums text-slate-800 dark:text-slate-100">
            {formatAmount(stream.claimableAmount, stream.tokenDecimals)}
          </dd>
        </div>
      </dl>

      {error ? (
        <p
          data-testid="stream-error"
          role="alert"
          className="mt-3 rounded-md bg-rose-50 p-2 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}

      <footer className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="stream-withdraw-btn"
          onClick={() => void withdraw(stream.claimableAmount)}
          disabled={stream.claimableAmount === '0'}
          className="h-8 rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Withdraw
        </button>
        <button
          type="button"
          data-testid="stream-topup-btn"
          onClick={() => void topUp('1000000')}
          className="h-8 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Top up
        </button>
        <button
          type="button"
          data-testid="stream-pause-btn"
          onClick={() => void pause()}
          className="h-8 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Pause
        </button>
        <button
          type="button"
          data-testid="stream-cancel-btn"
          onClick={() => void cancel()}
          className="h-8 rounded-lg border border-slate-300 px-3 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-950"
        >
          Cancel
        </button>
      </footer>
    </article>
  );
}

export default StreamCard;
