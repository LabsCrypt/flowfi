"use client";


import { useTokenPrice, formatFiatAmount, formatRatePerPeriod } from "@/hooks/useTokenPrice";
import { useSettings } from "@/hooks/useSettings";

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
  const { data: tokenPrice, isLoading } = useTokenPrice({ tokenSymbol });

  if (isLoading || !tokenPrice) {
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <span className="animate-pulse bg-slate-800/60 h-5 w-24 rounded" />
      </div>
    );
  }

  // Determine currency from display setting
  const currency = displayCurrency === "USD" || displayCurrency === "XLM" || displayCurrency === "USDC"
    ? "USD"
    : displayCurrency as "USD" | "EUR" | "GBP";

  const priceKey = `price${currency}` as keyof typeof tokenPrice;
  const tokenPriceForCurrency = tokenPrice[priceKey] as number || tokenPrice.priceUSD;

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
        </div>
      )}

      {/* Rate display */}
      {(showRate || showDaily || showMonthly) && ratePerSecond && (
        <div className="flex flex-wrap gap-3 text-sm">
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
