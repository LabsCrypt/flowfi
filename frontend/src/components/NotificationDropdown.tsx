"use client";
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useStreamEvents } from '@/hooks/useStreamEvents';
import { fromStroops } from '@/utils/amount';
import { Button } from './ui/Button';
import { BackendStreamEvent } from '@/lib/api-types';
import { fetchUserEvents } from '@/lib/dashboard';

interface NotificationDropdownProps {
    publicKey: string;
}

interface NotificationItem {
    id: string;
    streamId: number;
    type: string;
    message: string;
    timestamp: number;
    read: boolean;
}

export const NotificationDropdown: React.FC<NotificationDropdownProps> = ({ publicKey }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isLoading, setIsLoading] = useState(false);

    // Subscribe to live stream events for the user
    const { events: streamEvents, connected } = useStreamEvents({
        userPublicKeys: [publicKey],
        autoReconnect: true
    });

    const formatEventMessage = useCallback((event: { type: string; data?: any }): string => {
        const data = event.data || {};
        const streamId = data.streamId || 0;
        const amountStr = data.amount || data.feeAmount || '0';
        const amount = fromStroops(BigInt(amountStr), 7);
        const tokenSymbol = data.tokenSymbol || 'USDC';

        switch (event.type) {
            case 'created':
            case 'CREATED':
                return `New stream #${streamId} created`;
            case 'topped_up':
            case 'TOPPED_UP':
                return `Stream #${streamId} topped up by ${amount} ${tokenSymbol}`;
            case 'withdrawn':
            case 'WITHDRAWN':
                return `Received ${amount} ${tokenSymbol} from stream #${streamId}`;
            case 'cancelled':
            case 'CANCELLED':
                return `Stream #${streamId} cancelled`;
            case 'completed':
            case 'COMPLETED':
                return `Stream #${streamId} completed`;
            case 'paused':
                return `Stream #${streamId} paused`;
            case 'resumed':
                return `Stream #${streamId} resumed`;
            default:
                return `Activity on stream #${streamId}`;
        }
    }, []);

    const loadEvents = async () => {
        if (!publicKey) return;
        setIsLoading(true);
        try {
            const data = await fetchUserEvents(publicKey);
            const historyNotifs = data.slice(0, 20).map((event: BackendStreamEvent) => ({
                id: `history-${event.id}`,
                streamId: event.streamId,
                type: event.eventType,
                message: formatEventMessage({ 
                    type: event.eventType, 
                    data: { 
                        streamId: event.streamId, 
                        amount: event.amount 
                    } 
                }),
                timestamp: event.timestamp * 1000,
                read: true
            }));
            setNotifications(historyNotifs);
        } catch (error) {
            console.error('Failed to load events:', error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen && publicKey) {
            loadEvents();
            setUnreadCount(0);
        }
    }, [isOpen, publicKey]);

    // Handle incoming SSE events
    useEffect(() => {
        if (streamEvents.length > 0) {
            const latestEvent = streamEvents[0];
            const newNotif: NotificationItem = {
                id: `live-${Date.now()}-${latestEvent.type}`,
                streamId: latestEvent.data.streamId || 0,
                type: latestEvent.type,
                message: formatEventMessage(latestEvent),
                timestamp: latestEvent.timestamp,
                read: isOpen
            };

            if (!isOpen) {
                setUnreadCount(prev => prev + 1);
            }

            setNotifications(prev => {
                const combined = [newNotif, ...prev];
                const unique = combined.filter((notif, index, self) => 
                    index === self.findIndex(n => n.id === notif.id)
                );
                return unique.slice(0, 20);
            });
        }
    }, [streamEvents, isOpen, formatEventMessage]);

    const handleDropdownOpen = useCallback(() => {
        setIsOpen(!isOpen);
    }, [isOpen]);

    return (
        <div className="relative">
            <button
                onClick={handleDropdownOpen}
                className="relative p-2 text-slate-400 hover:text-accent transition-colors"
                disabled={!connected}
            >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 h-5 w-5 bg-accent rounded-full border-2 border-background flex items-center justify-center text-xs font-bold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
                {!connected && (
                    <span className="absolute bottom-0 right-0 h-2 w-2 bg-red-500 rounded-full border-2 border-background"></span>
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-background/95 backdrop-blur-md border border-glass-border rounded-2xl shadow-2xl z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2">
                    <div className="p-4 border-b border-glass-border flex justify-between items-center">
                        <h3 className="font-bold text-white">Notifications</h3>
                        <div className="flex items-center gap-2">
                            {!connected && (
                                <span className="text-xs text-red-400">Reconnecting...</span>
                            )}
                            <button
                                onClick={() => setIsOpen(false)}
                                className="text-slate-400 hover:text-white"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                        {isLoading ? (
                            <div className="p-8 text-center text-slate-400 text-sm">Loading...</div>
                        ) : notifications.length > 0 ? (
                            <div className="divide-y divide-glass-border">
                                {notifications.map((notification) => (
                                    <div 
                                        key={notification.id} 
                                        className={`p-4 hover:bg-white/5 transition-colors ${!notification.read ? 'bg-white/2' : ''}`}
                                    >
                                        <p className="text-sm text-white font-medium">{notification.message}</p>
                                        <p className="text-xs text-slate-400 mt-1">
                                            {new Date(notification.timestamp).toLocaleString()}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-8 text-center text-slate-400 text-sm">
                                {connected ? 'No new notifications' : 'Connecting to live updates...'}
                            </div>
                        )}
                    </div>
                    <div className="p-3 border-t border-glass-border">
                        <Button 
                            variant="ghost" 
                            size="sm" 
                            className="w-full text-xs"
                            onClick={() => {
                                window.location.href = '/activity';
                            }}
                        >
                            View All Activity
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};
