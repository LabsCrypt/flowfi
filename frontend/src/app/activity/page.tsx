"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@/context/wallet-context';
import { BackendStreamEvent } from '@/lib/api-types';
import { fetchUserEvents } from '@/lib/dashboard';
import { ActivityHistory } from '@/components/dashboard/ActivityHistory';
import { downloadCSV } from '@/utils/csvExport';
import { fromStroops } from '@/utils/amount';

type EventFilter = 'All' | 'CREATED' | 'TOPPED_UP' | 'WITHDRAWN' | 'CANCELLED' | 'COMPLETED';

export default function ActivityPage() {
    const { session } = useWallet();
    const [events, setEvents] = useState<BackendStreamEvent[]>([]);
    const [filteredEvents, setFilteredEvents] = useState<BackendStreamEvent[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeFilter, setActiveFilter] = useState<EventFilter>('All');

    useEffect(() => {
        if (session?.publicKey) {
            loadEvents();
        }
    }, [session?.publicKey, loadEvents]);

    useEffect(() => {
        if (activeFilter === 'All') {
            setFilteredEvents(events);
        } else {
            setFilteredEvents(events.filter(e => e.eventType === activeFilter));
        }
    }, [activeFilter, events]);

    const loadEvents = useCallback(async () => {
        if (!session?.publicKey) return;
        setIsLoading(true);
        try {
            const data = await fetchUserEvents(session.publicKey);
            setEvents(data);
            setFilteredEvents(data);
        } catch (error) {
            console.error('Failed to load events:', error);
        } finally {
            setIsLoading(false);
        }
    }, [session?.publicKey]);

    const handleExportCSV = () => {
        const csvData = filteredEvents.map(event => ({
            'Stream ID': event.streamId,
            'Event Type': event.eventType,
            'Amount': event.amount ? fromStroops(BigInt(event.amount), 7) : '0',
            'Timestamp': new Date(event.timestamp * 1000).toLocaleString(),
            'Transaction Hash': event.transactionHash,
            'Ledger': event.ledgerSequence,
        }));
        downloadCSV(csvData, `flowfi-activity-${Date.now()}.csv`);
    };

    const filters: EventFilter[] = ['All', 'CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED'];

    if (!session) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/5 flex items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold text-white mb-4">Connect Your Wallet</h1>
                    <p className="text-slate-400">Please connect your wallet to view activity history</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/5 p-6">
            <div className="max-w-6xl mx-auto">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-white mb-2">Stream Activity History</h1>
                    <p className="text-slate-400">View all your stream events and transactions</p>
                </div>

                <div className="bg-white/5 border border-glass-border rounded-2xl p-6 mb-6">
                    <div className="flex flex-wrap gap-2 mb-4">
                        {filters.map(filter => (
                            <button
                                key={filter}
                                onClick={() => setActiveFilter(filter)}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    activeFilter === filter
                                        ? 'bg-accent text-white'
                                        : 'bg-white/5 text-slate-400 hover:bg-white/10'
                                }`}
                            >
                                {filter === 'All' ? 'All Events' : filter.replace('_', ' ')}
                            </button>
                        ))}
                    </div>

                    <div className="flex justify-between items-center">
                        <p className="text-sm text-slate-400">
                            Showing {filteredEvents.length} of {events.length} events
                        </p>
                        <button
                            onClick={handleExportCSV}
                            disabled={filteredEvents.length === 0}
                            className="px-4 py-2 bg-accent/10 text-accent rounded-lg text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Export CSV
                        </button>
                    </div>
                </div>

                <ActivityHistory events={filteredEvents} isLoading={isLoading} />
            </div>
        </div>
    );
}
