import React from 'react';
import { BackendStreamEvent } from '@/lib/api-types';
import { fromStroops } from '@/utils/amount';
import TransactionTracker from '@/components/TransactionTracker';
import Link from 'next/link';

interface ActivityHistoryProps {
    events: BackendStreamEvent[];
    isLoading?: boolean;
}

export const ActivityHistory: React.FC<ActivityHistoryProps> = ({ events, isLoading }) => {
    const formatEventMessage = (event: BackendStreamEvent) => {
        const amount = event.amount ? fromStroops(BigInt(event.amount), 7) : '0';
        const streamId = event.streamId;

        switch (event.eventType) {
            case 'CREATED':
                return `A new stream was created (#${streamId})`;
            case 'TOPPED_UP':
                return `You topped up Stream #${streamId} with ${amount} tokens`;
            case 'WITHDRAWN':
                return `You withdrew ${amount} tokens from Stream #${streamId}`;
            case 'CANCELLED':
                return `Stream #${streamId} was cancelled`;
            case 'COMPLETED':
                return `Stream #${streamId} was completed`;
            default:
                return `Event on Stream #${streamId}`;
        }
    };

    const getEventBadgeColor = (eventType: string) => {
        switch (eventType) {
            case 'CREATED': return 'bg-blue-500/10 text-blue-400';
            case 'TOPPED_UP': return 'bg-green-500/10 text-green-400';
            case 'WITHDRAWN': return 'bg-purple-500/10 text-purple-400';
            case 'CANCELLED': return 'bg-red-500/10 text-red-400';
            case 'COMPLETED': return 'bg-emerald-500/10 text-emerald-400';
            default: return 'bg-accent/10 text-accent';
        }
    };

    if (isLoading) {
        return (
            <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="animate-pulse p-4 bg-white/5 border border-glass-border rounded-xl">
                        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2"></div>
                        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
                    </div>
                ))}
            </div>
        );
    }

    if (events.length === 0) {
        return (
            <div className="text-center py-8 text-slate-400">
                No activity found.
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {events.map((event) => (
                <div key={event.id} className="p-4 bg-white/5 border border-glass-border rounded-xl hover:bg-white/10 transition-colors">
                    <div className="flex justify-between items-start mb-3">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                                <Link 
                                    href={`/streams/${event.streamId}`}
                                    className="text-white font-medium hover:text-accent transition-colors"
                                >
                                    {formatEventMessage(event)}
                                </Link>
                            </div>
                            <p className="text-xs text-slate-400">
                                {new Date(event.timestamp * 1000).toLocaleString()}
                            </p>
                        </div>
                        <div className={`text-xs px-3 py-1 rounded-full font-semibold ${getEventBadgeColor(event.eventType)}`}>
                            {event.eventType}
                        </div>
                    </div>
                    {event.amount && (
                        <div className="mb-2 text-sm text-slate-300">
                            Amount: <span className="font-mono font-semibold">{fromStroops(BigInt(event.amount), 7)}</span>
                        </div>
                    )}
                    {event.txHash && (
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-slate-400">Tx:</span>
                            <a
                                href={`https://stellar.expert/explorer/testnet/tx/${event.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent hover:underline font-mono truncate max-w-xs"
                            >
                                {event.txHash}
                            </a>
                            <svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                        </div>
                    )}
                    {(event.txHash || event.transactionStatus) && (
                        <div className="mt-3">
                            <TransactionTracker
                                status={event.transactionStatus || 'confirmed'}
                                txHash={event.txHash}
                                streamId={event.streamId}
                            />
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};
