'use client';

import React, { useState } from 'react';
import toast from "react-hot-toast";
import type { Stream } from '@/lib/dashboard';

interface IncomingStreamsProps {
    streams: Stream[];
}

const IncomingStreams: React.FC<IncomingStreamsProps> = ({ streams }) => {
    const [filter, setFilter] = useState<'All' | 'Active' | 'Completed' | 'Paused'>('All');

    const filteredStreams = filter === 'All'
        ? streams
        : streams.filter(s => s.status === filter);

    const handleWithdraw = async () => {
        const toastId = toast.loading("Transaction pending...");

        try {
            // Simulate async transaction (replace with real blockchain call later)
            await new Promise((resolve) => setTimeout(resolve, 2000));

            toast.success("Withdrawal successful!", { id: toastId });
        } catch {
            toast.error("Transaction failed.", { id: toastId });
        }
    };

    const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setFilter(e.target.value as 'All' | 'Active' | 'Completed' | 'Paused');
    };

    return (
        <div className="bg-white/40 dark:bg-slate-900/40 backdrop-blur-md rounded-2xl border border-white/20 dark:border-white/10 shadow-xl overflow-hidden">
            <div className="p-6 border-b border-white/20 dark:border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-gray-900 dark:text-white">Incoming Payment Streams</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage and withdraw from your active incoming streams</p>
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
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {filteredStreams.map((stream) => (
                            <tr key={stream.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 font-mono">{stream.id}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stream.token}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stream.deposited} {stream.token}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 font-bold">{stream.withdrawn} {stream.token}</td>
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
                                        disabled={stream.status !== 'Active'}
                                        onClick={handleWithdraw}
                                        className={`px-4 py-2 rounded-lg transition-all ${stream.status === 'Active'
                                                ? 'bg-accent text-white hover:bg-accent-hover shadow-lg'
                                                : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                                            }`}
                                    >
                                        Withdraw
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
