/** Presentation helpers shared by the analytics components. */

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function trimDecimal(value: number): string {
  const fixed = value.toFixed(value < 10 ? 1 : 0);
  return fixed.replace(/\.0$/, '');
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return usdFormatter.format(value);
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${trimDecimal(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}${trimDecimal(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trimDecimal(abs / 1_000)}K`;
  return `${sign}${trimDecimal(abs)}`;
}

export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${formatCompact(value)}`;
}

export function formatNumber(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(value);
}

export function formatTokenAmount(value: number, symbol: string): string {
  if (!Number.isFinite(value)) return `— ${symbol}`;
  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 4,
  }).format(value);
  return `${formatted} ${symbol}`;
}

export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatRunway(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '0d';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (!address) return '—';
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function formatDate(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Deterministic HSL colour per token symbol, used by charts and legends. */
export function tokenColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash * 31 + symbol.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 68%, 55%)`;
}
