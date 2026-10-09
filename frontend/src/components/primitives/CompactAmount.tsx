/**
 * CompactAmount — render a large token balance as a short string, with the
 * exact decimal available on hover (issue #1509).
 *
 * Uses the native browser `title` attribute for the tooltip. That keeps this
 * component dependency-free and guarantees the exact value is accessible via
 * screen readers, keyboard focus, and long-press on mobile, without a JS
 * popover that can be clipped by table overflow.
 */
import { formatTokenCompact } from "@/utils/amount";

export interface CompactAmountProps {
  amount: bigint;
  decimals?: number;
  symbol?: string;
  locale?: string;
  className?: string;
}

export function CompactAmount({
  amount,
  decimals = 7,
  symbol,
  locale = "en",
  className,
}: CompactAmountProps) {
  const { compact, exact } = formatTokenCompact(amount, decimals, { locale });
  const text = symbol ? `${compact} ${symbol}` : compact;
  const title = symbol ? `${exact} ${symbol}` : exact;
  return (
    <span className={className} title={title} aria-label={title} data-exact={exact}>
      {text}
    </span>
  );
}