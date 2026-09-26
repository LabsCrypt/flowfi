/**
 * Marketing stats strip.
 *
 * The values below are still static copy — wiring them to the real stats
 * endpoint is tracked separately. What this file *does* guarantee is that when
 * that wiring lands, absent or malformed data degrades gracefully: every value
 * is rendered through `formatStatValue`, which never emits "NaN", "undefined"
 * or an empty cell. Callers can already pass a `stats` prop (as the fetching
 * layer eventually will) and the placeholder layout holds its shape.
 */

/** Placeholder shown when a stat value is missing or not renderable. */
export const STAT_FALLBACK = '--';

export type StatValue = string | number | null | undefined;

export interface StatItem {
    label: string;
    value: StatValue;
    /** Optional text-gradient utility class; falls back to plain white. */
    gradient?: string;
}

const DEFAULT_STATS: readonly StatItem[] = [
    { label: 'Network', value: 'Stellar Testnet', gradient: 'text-gradient' },
    { label: 'Status', value: 'Early Access', gradient: 'text-white' },
    { label: 'Settlement', value: 'Real-time', gradient: 'text-gradient-secondary' },
];

/**
 * Convert a raw stat value into something safe to render.
 *
 * Returns {@link STAT_FALLBACK} for null, undefined, NaN, Infinity and
 * blank strings so the marketing page never shows "NaN" or "undefined".
 * Zero is a legitimate value and renders as "0".
 */
export function formatStatValue(value: StatValue): string {
    if (value === null || value === undefined) return STAT_FALLBACK;

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return STAT_FALLBACK;
        return new Intl.NumberFormat('en-US', {
            notation: 'compact',
            maximumFractionDigits: 1,
        }).format(value);
    }

    const trimmed = value.trim();
    return trimmed === '' ? STAT_FALLBACK : trimmed;
}

interface StatsProps {
    /**
     * Stats to display. `undefined` (the default) renders the static copy;
     * `null` or an empty array — i.e. the endpoint returned nothing or errored —
     * keeps the labels and layout but shows {@link STAT_FALLBACK} for each value.
     */
    stats?: readonly StatItem[] | null;
}

export const Stats = ({ stats }: StatsProps) => {
    const items: readonly StatItem[] =
        stats === undefined
            ? DEFAULT_STATS
            : stats && stats.length > 0
                ? stats
                : DEFAULT_STATS.map((stat) => ({ ...stat, value: null }));

    return (
        <section className="py-20 border-y border-glass-border bg-background relative z-10">
            <div className="mx-auto max-w-6xl px-6 md:px-12">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-12 text-center">
                    {items.map((stat, i) => (
                        <div key={`${stat.label}-${i}`} className="flex flex-col items-center">
                            <span className={`text-4xl md:text-5xl font-black tracking-tighter ${stat.gradient ?? 'text-white'}`}>
                                {formatStatValue(stat.value)}
                            </span>
                            <span className="mt-3 text-xs md:text-sm font-bold uppercase tracking-[0.2em] text-slate-500">
                                {stat.label}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
};
