'use client';

import React, { useState } from 'react';
import type { Stream } from '@/lib/dashboard';
import { useStreamingAmount } from '@/hooks/useStreamingAmount';

interface IncomingStreamsProps {
    streams: Stream[];
    onWithdraw: (stream: Stream) => Promise<void>;
    withdrawingStreamId?: string | null;
}

function formatTokenAmount(value: number): string {
    if (!Number.isFinite(value)) return '0.0000';

    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
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

    const liveRate = stream.status === 'Active' && stream.ratePerSecond > 0;

    return (
        <div className="flex flex-col">
            <span className={`font-bold tabular-nums ${liveRate ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-900 dark:text-gray-100'}`}>
                {formatTokenAmount(claimable)} {stream.token}
            </span>
            <span className={`text-xs tabular-nums ${liveRate ? 'text-emerald-500 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`}>
                {liveRate
                    ? `+${formatTokenAmount(stream.ratePerSecond)} ${stream.token}/sec`
                    : 'Stream inactive'}
            </span>
        </div>
    );
};

const IncomingStreams: React.FC<IncomingStreamsProps> = ({
    streams,
    onWithdraw,
    withdrawingStreamId = null,
}) => {
    const [filter, setFilter] = useState<'All' | 'Active' | 'Completed' | 'Paused'>('All');

    const filteredStreams = filter === 'All'
        ? streams
        : streams.filter((s) => s.status === filter);

    const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setFilter(e.target.value as 'All' | 'Active' | 'Completed' | 'Paused');
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
                    <label htmlFor="filter" className="text-sm font-medium text-gray-700 dark:text-gray-300">Filter:</label>
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
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead className="bg-gray-50/50 dark:bg-gray-800/50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Sender</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Token</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Deposited</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Withdrawn</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Claimable</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {filteredStreams.map((stream) => (
                            <tr key={stream.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="text-sm text-gray-900 dark:text-gray-100 font-mono">{stream.recipient}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">Stream #{stream.id}</div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stream.token}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 tabular-nums">{formatTokenAmount(stream.deposited)} {stream.token}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 font-bold tabular-nums">{formatTokenAmount(stream.withdrawn)} {stream.token}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    <ClaimableAmount stream={stream} />
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full 
                                        ${stream.status === 'Active' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                                            stream.status === 'Completed' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                                                'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'}`}>
                                        {stream.status}
                                    </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                    <button
                                        disabled={stream.status !== 'Active' || withdrawingStreamId === stream.id}
                                        onClick={() => {
                                            void onWithdraw(stream);
                                        }}
                                        className={`px-4 py-2 rounded-lg transition-all ${stream.status === 'Active'
                                                ? 'bg-accent text-white hover:bg-accent-hover shadow-lg'
                                                : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                                            }`}
                                    >
                                        {withdrawingStreamId === stream.id ? 'Withdrawing...' : 'Withdraw'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {filteredStreams.length === 0 && (
                <div className="p-12 text-center">
                    <p className="text-gray-500 dark:text-gray-400">No incoming streams found matching the filter.</p>
                </div>
            )}
        </div>
    );
};

export default IncomingStreams;
