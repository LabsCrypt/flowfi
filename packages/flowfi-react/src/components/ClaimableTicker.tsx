'use client';

import { useClaimableBalance } from '../hooks/useClaimableBalance';
import type { FlowFiStream } from '../types';

export interface ClaimableTickerProps {
  stream: FlowFiStream | null | undefined;
  /** 'raw' shows whole-token amount; 'usd' multiplies by usdRate. */
  format?: 'raw' | 'usd';
  /** Animate the value with requestAnimationFrame. Default true. */
  animated?: boolean;
  className?: string;
  /** Override the token symbol shown next to the number. */
  symbol?: string;
}

export function ClaimableTicker({
  stream,
  format = 'raw',
  animated = true,
  className,
  symbol,
}: ClaimableTickerProps) {
  const { claimable } = useClaimableBalance(stream, { enabled: animated });

  const display =
    format === 'usd' && stream?.usdRate
      ? (claimable * stream.usdRate).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 2,
        })
      : `${claimable.toLocaleString('en-US', { maximumFractionDigits: 4 })}${
          symbol ?? stream?.token?.symbol ? ` ${symbol ?? stream?.token?.symbol}` : ''
        }`;

  return (
    <span
      data-testid="claimable-ticker"
      className={className ?? 'tabular-nums'}
      aria-live="polite"
    >
      {display}
    </span>
  );
}
