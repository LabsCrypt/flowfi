"use client";

import { useTokenPrice, formatFiatAmount, formatRatePerPeriod } from "@/hooks/useTokenPrice";
import { useSettings } from "@/hooks/useSettings";

export const STALE_PRICE_THRESHOLD_MS = 5 * 60 * 1000;

export function getPriceStaleness(
  lastUpdatedAt: number | null | undefined,
  nowMs: number = Date.now(),
): {
  isStale: boolean;
  staleMinutes: number;
  tooltip: string | null;
} {
  if (typeof lastUpdatedAt !== "number" || !Number.isFinite(lastUpdatedAt)) {
    return { isStale: false, staleMinutes: 0, tooltip: null };
  }
  const ageMs = nowMs - lastUpdatedAt;
  if (ageMs <= STALE_PRICE_THRESHOLD_MS) {
    return { isStale: false, staleMinutes: 0, tooltip: null };
  }
  const staleMinutes = Math.max(1, Math.floor(ageMs / 60_000));
  return {
    isStale: true,
    staleMinutes,
    tooltip: `Price estimate last updated ${staleMinutes} minutes ago`,
  };
}

interface FiatEquivalentProps {
  tokenSymbol: string;
  amount?: string | bigint;
  ratePerSecond?: string | bigint;
  showRate?: boolean;
  showDaily?: boolean;
  showMonthly?: boolean;
  className?: string;
}

/**
 * Displays token amount with fiat equivalent in dual denomination badges
 * Example: 1,500.00 USDC (≈ $1,500.00 USD)
 */
export function FiatEquivalent({
  tokenSymbol,
  amount,
  ratePerSecond,
  showRate = false,
  showDaily = false,
  showMonthly = false,
  className = "",
}: FiatEquivalentProps) {
  const { displayCurrency } = useSettings();
  const {
    data: tokenPrice,
    isLoading,
    lastUpdatedAt: hookLastUpdatedAt,
  } = useTokenPrice({ tokenSymbol });

  if (isLoading || !tokenPrice) {
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <span className="animate-pulse bg-slate-800/60 h-5 w-24 rounded" />
      </div>
    );
  }

  // Determine currency from display setting
  const currency =
    displayCurrency === "USD" || displayCurrency === "XLM" || displayCurrency === "USDC"
      ? "USD"
      : (displayCurrency as "USD" | "EUR" | "GBP");

  const priceKey = `price${currency}` as keyof typeof tokenPrice;
  const candidatePrice = tokenPrice[priceKey] ?? tokenPrice.priceUSD;
  const tokenPriceForCurrency =
    typeof candidatePrice === "number" && Number.isFinite(candidatePrice)
      ? candidatePrice
      : 0;

  const resolvedLastUpdatedAt =
    typeof hookLastUpdatedAt === "number" && Number.isFinite(hookLastUpdatedAt)
      ? hookLastUpdatedAt
      : typeof tokenPrice.timestamp === "number" && Number.isFinite(tokenPrice.timestamp)
        ? tokenPrice.timestamp
        : null;

  const { isStale, tooltip: staleTooltip } = getPriceStaleness(
    resolvedLastUpdatedAt,
  );

  const staleWarningIndicator =
    isStale && staleTooltip ? (
      <span
        data-testid="stale-price-warning"
        title={staleTooltip}
        aria-label={staleTooltip}
        aria-describedby="fiat-stale-price-tooltip"
        tabIndex={0}
        className="group relative inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-xs font-medium text-amber-400 cursor-help focus:outline-none focus:ring-2 focus:ring-amber-400/50"
      >
        <svg
          className="h-3.5 w-3.5 shrink-0 text-amber-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span
          id="fiat-stale-price-tooltip"
          role="tooltip"
          className="sr-only group-hover:not-sr-only group-focus-visible:not-sr-only group-hover:absolute group-hover:bottom-full group-hover:left-1/2 group-hover:-translate-x-1/2 group-hover:mb-1.5 group-hover:whitespace-nowrap group-hover:rounded-md group-hover:bg-slate-900 group-hover:px-2.5 group-hover:py-1 group-hover:text-xs group-hover:text-amber-200 group-hover:shadow-lg group-hover:border group-hover:border-amber-500/30 z-20"
        >
          {staleTooltip}
        </span>
      </span>
    ) : null;

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Amount display */}
      {amount && (
        <div className="inline-flex items-center gap-2 flex-wrap">
          <span className="font-semibold">
            {typeof amount === "bigint" 
              ? (Number(amount) / 10 ** 7).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })
              : Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })
            } {tokenSymbol}
          </span>
          <span className="text-sm text-slate-400">
            (≈ {formatFiatAmount(
              typeof amount === "bigint" 
                ? (Number(amount) / 10 ** 7) * tokenPriceForCurrency
                : Number(amount) * tokenPriceForCurrency,
              currency
            )} {currency})
          </span>
          {staleWarningIndicator}
        </div>
      )}

      {/* Rate display */}
      {(showRate || showDaily || showMonthly) && ratePerSecond && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {showRate && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-800/50 text-slate-300">
              <span className="font-mono">
                {(Number(ratePerSecond) / 10 ** 7).toFixed(6)} {tokenSymbol}/sec
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-accent">
                ≈ {formatRatePerPeriod(
                  Number(ratePerSecond) / 10 ** 7,
                  tokenPriceForCurrency,
                  "second",
                  currency
                )}/sec
              </span>
            </span>
          )}
          {showDaily && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-800/50 text-slate-300">
              <span className="text-accent">
                ≈ {formatRatePerPeriod(
                  Number(ratePerSecond) / 10 ** 7,
                  tokenPriceForCurrency,
                  "hour",
                  currency
                )}/hour
              </span>
            </span>
          )}
          {showDaily && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-800/50 text-slate-300">
              <span className="text-accent">
                ≈ {formatRatePerPeriod(
                  Number(ratePerSecond) / 10 ** 7,
                  tokenPriceForCurrency,
                  "day",
                  currency
                )}/day
              </span>
            </span>
          )}
          {showMonthly && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-800/50 text-slate-300">
              <span className="text-accent">
                ≈ {formatRatePerPeriod(
                  Number(ratePerSecond) / 10 ** 7,
                  tokenPriceForCurrency,
                  "month",
                  currency
                )}/month
              </span>
            </span>
          )}
          {!amount && staleWarningIndicator}
        </div>
      )}
    </div>
  );
}

/**
 * Compact version for stream cards
 */
export function FiatBadge({
  tokenSymbol,
  amount,
  className = "",
}: {
  tokenSymbol: string;
  amount: string | bigint;
  className?: string;
}) {
  const { displayCurrency } = useSettings();
  const { data: tokenPrice } = useTokenPrice({ tokenSymbol });

  if (!tokenPrice) return null;

  const currency = displayCurrency === "USD" || displayCurrency === "XLM" || displayCurrency === "USDC"
    ? "USD"
    : displayCurrency as "USD" | "EUR" | "GBP";

  const priceKey = `price${currency}` as keyof typeof tokenPrice;
  const tokenPriceForCurrency = tokenPrice[priceKey] as number || tokenPrice.priceUSD;

  const amountNum = typeof amount === "bigint" 
    ? Number(amount) / 10 ** 7
    : Number(amount);

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${className}`}>
      <span className="text-slate-400">≈</span>
      <span className="text-accent">
        {formatFiatAmount(amountNum * tokenPriceForCurrency, currency)}
      </span>
    </span>
  );
}