import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stats, formatStatValue, STAT_FALLBACK } from './Stats';

/**
 * Guards the marketing homepage against the stats endpoint returning zero,
 * null or an error: none of those may surface as "NaN"/"undefined" text or
 * collapse the three-column layout (issue #1125).
 */

const renderedValues = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.tracking-tighter')).map((el) => el.textContent);

const expectNoBrokenText = () => {
    expect(document.body.textContent).not.toContain('NaN');
    expect(document.body.textContent).not.toContain('undefined');
    expect(document.body.textContent).not.toContain('null');
};

describe('formatStatValue', () => {
    it('falls back for null and undefined', () => {
        expect(formatStatValue(null)).toBe(STAT_FALLBACK);
        expect(formatStatValue(undefined)).toBe(STAT_FALLBACK);
    });

    it('falls back for NaN and non-finite numbers', () => {
        expect(formatStatValue(Number.NaN)).toBe(STAT_FALLBACK);
        expect(formatStatValue(Number.POSITIVE_INFINITY)).toBe(STAT_FALLBACK);
        expect(formatStatValue(Number.NEGATIVE_INFINITY)).toBe(STAT_FALLBACK);
    });

    it('falls back for blank strings', () => {
        expect(formatStatValue('')).toBe(STAT_FALLBACK);
        expect(formatStatValue('   ')).toBe(STAT_FALLBACK);
    });

    it('renders zero as "0" rather than falling back', () => {
        expect(formatStatValue(0)).toBe('0');
    });

    it('formats larger numbers compactly', () => {
        expect(formatStatValue(1500)).toBe('1.5K');
        expect(formatStatValue(2_400_000)).toBe('2.4M');
    });

    it('passes strings through, trimmed', () => {
        expect(formatStatValue('Stellar Testnet')).toBe('Stellar Testnet');
        expect(formatStatValue('  Real-time  ')).toBe('Real-time');
    });
});

describe('Stats', () => {
    it('renders the default copy when no data is supplied', () => {
        const { container } = render(<Stats />);

        expect(screen.getByText('Stellar Testnet')).toBeInTheDocument();
        expect(screen.getByText('Early Access')).toBeInTheDocument();
        expect(screen.getByText('Real-time')).toBeInTheDocument();
        expect(renderedValues(container)).toHaveLength(3);
        expectNoBrokenText();
    });

    it('keeps labels and layout, showing the fallback, when the endpoint returns null', () => {
        const { container } = render(<Stats stats={null} />);

        expect(renderedValues(container)).toEqual([
            STAT_FALLBACK,
            STAT_FALLBACK,
            STAT_FALLBACK,
        ]);
        expect(screen.getByText('Network')).toBeInTheDocument();
        expect(screen.getByText('Status')).toBeInTheDocument();
        expect(screen.getByText('Settlement')).toBeInTheDocument();
        expectNoBrokenText();
    });

    it('shows the fallback when the endpoint returns an empty list', () => {
        const { container } = render(<Stats stats={[]} />);

        expect(renderedValues(container)).toEqual([
            STAT_FALLBACK,
            STAT_FALLBACK,
            STAT_FALLBACK,
        ]);
        expectNoBrokenText();
    });

    it('renders zero values as "0" instead of a fallback', () => {
        render(
            <Stats
                stats={[
                    { label: 'Total Value Locked', value: 0 },
                    { label: 'Active Streams', value: 0 },
                ]}
            />,
        );

        expect(screen.getAllByText('0')).toHaveLength(2);
        expect(screen.queryByText(STAT_FALLBACK)).not.toBeInTheDocument();
        expectNoBrokenText();
    });

    it('falls back per-stat when an error response omits or corrupts values', () => {
        const { container } = render(
            <Stats
                stats={[
                    { label: 'Total Value Locked', value: undefined },
                    { label: 'Active Streams', value: Number.NaN },
                    { label: 'Settlement', value: 'Real-time' },
                ]}
            />,
        );

        expect(renderedValues(container)).toEqual([
            STAT_FALLBACK,
            STAT_FALLBACK,
            'Real-time',
        ]);
        expect(screen.getByText('Total Value Locked')).toBeInTheDocument();
        expectNoBrokenText();
    });
});
