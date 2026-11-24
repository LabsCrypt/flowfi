'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { Stream } from '@/lib/dashboard';
import { useStreamingAmount } from '@/hooks/useStreamingAmount';
import { useTablePreferences } from '@/hooks/useTablePreferences';
import toast from 'react-hot-toast';
import { transactionSuccessToast } from '@/lib/transaction-feedback';


interface IncomingStreamsProps {
    streams: Stream[];
    onWithdraw: (stream: Stream) => Promise<void>;
    withdrawingStreamId?: string | null;
    /** Stream highlighted by keyboard navigation (j/k). */
    selectedStreamId?: string | null;
}

const COLUMNS = [
    { id: 'sender', label: 'Sender' },
    { id: 'token', label: 'Token' },
    { id: 'deposited', label: 'Deposited' },
    { id: 'withdrawn', label: 'Withdrawn' },
    { id: 'claimable', label: 'Claimable' },
    { id: 'status', label: 'Status' },
] as const;

type ColumnId = (typeof COLUMNS)[number]['id'];

const COLUMN_IDS: ColumnId[] = COLUMNS.map((column) => column.id);

const STORAGE_KEY = 'flowfi.table.incoming-streams.v1';

const HEADER_CELL_CLASS =
    'px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

/**
 * Stable comparator used for client-side sorting. "claimable" is compared
 * using deposited - withdrawn (the un-withdrawn remainder) rather than the
 * live per-second accrual, so rows do not jump around between renders.
 */
function compareStreams(sortBy: ColumnId, a: Stream, b: Stream): number {
    switch (sortBy) {
        case 'sender':
            return a.recipient.localeCompare(b.recipient);
        case 'token':
            return a.token.localeCompare(b.token);
        case 'deposited':
            return a.deposited - b.deposited;
        case 'withdrawn':
            return a.withdrawn - b.withdrawn;
        case 'claimable':
            return a.deposited - a.withdrawn - (b.deposited - b.withdrawn);
        case 'status':
            return a.status.localeCompare(b.status);
    }
}

/**
 * Format an already-human-scaled token amount (e.g. 10.5) for display.
 *
 * Values coming from the Stream interface have already been divided by 1e7
 * (stroops → token units) by the dashboard mapper, so we must NOT re-scale
 * them through formatAmount. Instead we format the number directly using
 * Intl.NumberFormat, consistent with IncomingStreamCard.
 */
function formatTokenAmount(value: number, maximumFractionDigits = 7): string {
    if (!Number.isFinite(value)) return '0.0000000';
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits,
    }).format(value);
}

const ClaimableAmount: React.FC<{ stream: Stream }> = ({ stream }) => {
    const claimable = useStreamingAmount({
        deposited: stream.deposited,
        withdrawn: stream.withdrawn,
        ratePerSecond: stream.ratePerSecond,
        lastUpdateTime: stream.lastUpdateTime,
        isActive: stream.status === 'Active' && stream.isActive,
    });

    const isPaused = stream.status === 'Paused';
    const liveRate = stream.status === 'Active' && stream.ratePerSecond > 0;

    return (
        <div className="flex flex-col">
            <span className={`font-bold tabular-nums ${liveRate ? 'text-emerald-600 dark:text-emerald-300' : isPaused ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
                {formatTokenAmount(claimable)} {stream.token}
            </span>
            <span className={`text-xs tabular-nums ${liveRate ? 'text-emerald-500 dark:text-emerald-400' : isPaused ? 'text-gray-400 dark:text-gray-500' : 'text-gray-400 dark:text-gray-500'}`}>
                {isPaused
                    ? 'Stream paused'
                    : liveRate
                        ? `+${formatTokenAmount(stream.ratePerSecond)} ${stream.token}/sec`
                        : 'Stream inactive'}
            </span>
        </div>
    );
};

/**
 * Shown when the current filter returns no results.
 * Distinguished from the global empty-state (no streams at all), which is
 * handled one level up in dashboard-view.tsx.
 */
const FilterEmptyState: React.FC<{ filter: string; onClearFilter: () => void }> = ({ filter, onClearFilter }) => (
    <div className="p-12 text-center">
        <div className="h-14 w-14 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
            <svg className="h-7 w-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                    d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
            </svg>
        </div>
        <p className="text-gray-600 dark:text-gray-400 font-medium">
            No <span className="lowercase">{filter}</span> streams found.
        </p>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
            Try a different filter or wait for new streams to arrive.
        </p>
        <button
            type="button"
            onClick={onClearFilter}
            className="mt-4 text-sm text-accent hover:underline"
        >
            Show all streams
        </button>
    </div>
);

const IncomingStreams: React.FC<IncomingStreamsProps> = ({
    streams,
    onWithdraw,
    withdrawingStreamId = null,
    selectedStreamId = null,
}) => {
    const [filter, setFilter] = useState<'All' | 'Active' | 'Completed' | 'Paused'>('All');
    const [showSettings, setShowSettings] = useState(false);
    const settingsRef = useRef<HTMLDivElement>(null);

    const {
        sortBy,
        sortDirection,
        isVisible,
        toggleColumn,
        setSort,
        resetPreferences,
    } = useTablePreferences<ColumnId>({
        storageKey: STORAGE_KEY,
        defaultColumns: COLUMN_IDS,
    });

    // Close the settings dropdown on outside click / Escape.
    useEffect(() => {
        if (!showSettings) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
                setShowSettings(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setShowSettings(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showSettings]);

    const filteredStreams = filter === 'All'
        ? streams
        : streams.filter((s) => s.status === filter);

    const sortedStreams = useMemo(() => {
        if (!sortBy) return filteredStreams;
        const direction = sortDirection === 'asc' ? 1 : -1;
        return [...filteredStreams].sort(
            (a, b) => direction * compareStreams(sortBy, a, b),
        );
    }, [filteredStreams, sortBy, sortDirection]);

    const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setFilter(e.target.value as 'All' | 'Active' | 'Completed' | 'Paused');
    };

    const handleResetLayout = () => {
        resetPreferences();
        setShowSettings(false);
    };

    const handleWithdraw = async (stream: Stream) => {
        try {
            await onWithdraw(stream);
            transactionSuccessToast(`Successfully withdrew from stream #${stream.id}`);
        } catch {
            toast.error(`Failed to withdraw from stream #${stream.id}`);
        }
    };

    return (
        <div className="bg-white/40 dark:bg-slate-900/40 backdrop-blur-md rounded-2xl border border-white/20 dark:border-white/10 shadow-xl overflow-hidden">
            <div className="p-6 border-b border-white/20 dark:border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-gray-900 dark:text-white">Incoming Payment Streams</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        Manage and withdraw from your active incoming streams
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <label htmlFor="filter" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Filter:
                    </label>
                    <select
                        id="filter"
                        value={filter}
                        onChange={handleFilterChange}
                        className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-1 text-sm focus:ring-2 focus:ring-accent outline-none"
                    >
                        <option value="All">All Streams</option>
                        <option value="Active">Active</option>
                        <option value="Paused">Paused</option>
                        <option value="Completed">Completed</option>
                    </select>

                    <div className="relative" ref={settingsRef}>
                        <button
                            type="button"
                            onClick={() => setShowSettings((open) => !open)}
                            aria-haspopup="true"
                            aria-expanded={showSettings}
                            aria-label="Table settings"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-accent focus:ring-2 focus:ring-accent outline-none"
                        >
                            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                            Columns
                        </button>

                        {showSettings && (
                            <div
                                role="menu"
                                aria-label="Table settings"
                                className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-800 p-2 shadow-xl"
                            >
                                <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                                    Visible columns
                                </p>
                                {COLUMNS.map((column) => (
                                    <label
                                        key={column.id}
                                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                                    >
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent"
                                            checked={isVisible(column.id)}
                                            onChange={() => toggleColumn(column.id)}
                                        />
                                        {column.label}
                                    </label>
                                ))}
                                <button
                                    type="button"
                                    onClick={handleResetLayout}
                                    className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg border-t border-gray-100 dark:border-gray-700 px-2 py-2 text-sm font-medium text-accent hover:bg-accent/10"
                                >
                                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                                    Reset Table Layout
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Empty state when the filter matches nothing */}
            {filteredStreams.length === 0 ? (
                <FilterEmptyState
                    filter={filter}
                    onClearFilter={() => setFilter('All')}
                />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead className="bg-gray-50/50 dark:bg-gray-800/50">
                            <tr>
                                {COLUMNS.map((column) =>
                                    isVisible(column.id) ? (
                                        <th key={column.id} className={HEADER_CELL_CLASS}>
                                            <button
                                                type="button"
                                                onClick={() => setSort(column.id)}
                                                aria-label={`Sort by ${column.label}`}
                                                className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-accent"
                                            >
                                                {column.label}
                                                {sortBy === column.id && (
                                                    sortDirection === 'asc' ? (
                                                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                                                    ) : (
                                                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                                                    )
                                                )}
                                            </button>
                                        </th>
                                    ) : null,
                                )}
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {sortedStreams.map((stream) => {
                                const isPaused = stream.status === 'Paused';
                                const isSelected = selectedStreamId === stream.id;
                                return (
                                    <tr
                                        key={stream.id}
                                        data-stream-id={stream.id}
                                        aria-selected={isSelected}
                                        className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${isPaused ? 'bg-gray-50/50 dark:bg-gray-800/50 opacity-75' : ''} ${isSelected ? 'bg-accent/10 ring-1 ring-inset ring-accent/50' : ''}`}
                                    >
                                        {isVisible('sender') && (
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className={`text-sm font-mono ${isPaused ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
                                                    {stream.recipient}
                                                </div>
                                                <div className="text-xs text-gray-500 dark:text-gray-400">Stream #{stream.id}</div>
                                            </td>
                                        )}
                                        {isVisible('token') && (
                                            <td className={`px-6 py-4 whitespace-nowrap text-sm ${isPaused ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
                                                {stream.token}
                                            </td>
                                        )}
                                        {isVisible('deposited') && (
                                            <td className={`px-6 py-4 whitespace-nowrap text-sm tabular-nums ${isPaused ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
                                                {formatTokenAmount(stream.deposited)} {stream.token}
                                            </td>
                                        )}
                                        {isVisible('withdrawn') && (
                                            <td className={`px-6 py-4 whitespace-nowrap text-sm font-bold tabular-nums ${isPaused ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
                                                {formatTokenAmount(stream.withdrawn)} {stream.token}
                                            </td>
                                        )}
                                        {isVisible('claimable') && (
                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                <ClaimableAmount stream={stream} />
                                            </td>
                                        )}
                                        {isVisible('status') && (
                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full
                                                    ${stream.status === 'Active' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                                                        stream.status === 'Paused' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
                                                            stream.status === 'Completed' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                                                                'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                                                    {stream.status}
                                                </span>
                                            </td>
                                        )}
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <button
                                                disabled={stream.status !== 'Active' || withdrawingStreamId === stream.id}
                                                onClick={() => { void handleWithdraw(stream); }}
                                                className={`px-4 py-2 rounded-lg transition-all ${
                                                    stream.status === 'Active'
                                                        ? 'bg-accent text-white hover:bg-accent-hover shadow-lg'
                                                        : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                                                }`}
                                            >
                                                {withdrawingStreamId === stream.id ? 'Withdrawing...' : 'Withdraw'}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default IncomingStreams;
