import React, { useState, useEffect } from 'react';
import { BackendStreamEvent } from '@/lib/api-types';
import { fetchUserEvents } from '@/lib/dashboard';
import { Button } from './ui/Button';

interface NotificationDropdownProps {
    publicKey: string;
}

export const NotificationDropdown: React.FC<NotificationDropdownProps> = ({ publicKey }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [events, setEvents] = useState<BackendStreamEvent[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isOpen && publicKey) {
            loadEvents();
        }
    }, [isOpen, publicKey]);

    const loadEvents = async () => {
        setIsLoading(true);
        try {
            const data = await fetchUserEvents(publicKey);
            setEvents(data.slice(0, 5)); // Show only last 5
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoading(false);
        }
    };

    const formatEventMessage = (event: BackendStreamEvent) => {
        const amount = event.amount ? parseFloat(event.amount) / 1e7 : 0;
        switch (event.eventType) {
            case 'CREATED': return `New stream #${event.streamId}`;
            case 'TOPPED_UP': return `Topped up #${event.streamId}`;
            case 'WITHDRAWN': return `Withdrew ${amount} from #${event.streamId}`;
            case 'CANCELLED': return `Cancelled #${event.streamId}`;
            default: return `Event on #${event.streamId}`;
        }
    };

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative p-2 text-slate-400 hover:text-accent transition-colors"
            >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {events.length > 0 && (
                    <span className="absolute top-0 right-0 h-3 w-3 bg-accent rounded-full border-2 border-background"></span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-background/95 backdrop-blur-md border border-glass-border rounded-2xl shadow-2xl z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2">
                    <div className="p-4 border-b border-glass-border flex justify-between items-center">
                        <h3 className="font-bold text-white">Notifications</h3>
                        <button
                            onClick={() => setIsOpen(false)}
                            className="text-slate-400 hover:text-white"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                        {isLoading ? (
                            <div className="p-8 flex justify-center">
                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                            </div>
                        ) : events.length > 0 ? (
                            <div className="divide-y divide-glass-border">
                                {events.map((event) => (
                                    <div key={event.id} className="p-4 hover:bg-white/5 transition-colors">
                                        <p className="text-sm text-white font-medium">{formatEventMessage(event)}</p>
                                        <p className="text-xs text-slate-400 mt-1">
                                            {new Date(event.timestamp * 1000).toLocaleString()}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-8 text-center text-slate-400 text-sm">
                                No new notifications
                            </div>
                        )}
                    </div>
                    <div className="p-3 border-t border-glass-border">
                        <Button variant="ghost" size="sm" className="w-full text-xs">
                            View All Activity
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};
