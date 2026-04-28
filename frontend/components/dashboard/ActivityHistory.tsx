import React from 'react';
import { BackendStreamEvent } from '@/lib/api-types';
import { fromStroops } from '@/utils/amount';
import TransactionTracker from '@/components/TransactionTracker';

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
                    <div className="flex justify-between items-start">
                        <div>
                            <p className="text-white font-medium">{formatEventMessage(event)}</p>
                            <p className="text-xs text-slate-400 mt-1">
                                {new Date(event.timestamp * 1000).toLocaleString()}
                            </p>
                        </div>
                        <div className="text-xs px-2 py-1 rounded bg-accent/10 text-accent font-semibold">
                            {event.eventType}
                        </div>
                    </div>
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
