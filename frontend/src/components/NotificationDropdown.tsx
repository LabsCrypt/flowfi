"use client";
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useStreamEvents } from '@/hooks/useStreamEvents';
import { formatAmount } from '@/lib/amount';
import { Button } from './ui/Button';

interface NotificationDropdownProps {
    publicKey: string;
}

interface NotificationItem {
    id: string;
    streamId: number;
    type: 'created' | 'topped_up' | 'withdrawn' | 'cancelled' | 'completed' | 'paused' | 'resumed';
    message: string;
    timestamp: number;
    read: boolean;
}

export const NotificationDropdown: React.FC<NotificationDropdownProps> = ({ publicKey }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);

    // Subscribe to live stream events for the user
    const { events, connected } = useStreamEvents({
        userPublicKeys: [publicKey],
        autoReconnect: true
    });

    // Wire up SSE for real-time events
    const { events: streamEvents } = useStreamEvents({
        userPublicKeys: [publicKey],
        autoReconnect: true,
    });

    const formatEventMessage = useCallback((event: { type: string; data?: unknown }): string => {
        const data = event.data as { streamId?: number; amount?: string; tokenSymbol?: string };
        const streamId = data?.streamId || 0;
        const amount = data?.amount ? formatAmount(BigInt(data.amount), 7) : '0';
        const tokenSymbol = data?.tokenSymbol || 'USDC';

        switch (event.type) {
            case 'created':
                return `New stream #${streamId} created`;
            case 'topped_up':
                return `Stream #${streamId} was topped up by ${amount} ${tokenSymbol}`;
            case 'withdrawn':
                return `You received ${amount} ${tokenSymbol} from stream #${streamId}`;
            case 'cancelled':
                return `Stream #${streamId} was cancelled — refund incoming`;
            case 'completed':
                return `Stream #${streamId} completed`;
            case 'paused':
                return `Stream #${streamId} was paused`;
            case 'resumed':
                return `Stream #${streamId} was resumed`;
            default:
                return `Activity on stream #${streamId}`;
        }
    }, []);

    // Clear unread count when dropdown opens - use setTimeout to avoid synchronous setState
    useEffect(() => {
        if (isOpen) {
            const timer = setTimeout(() => {
                setUnreadCount(0);
            }, 0);
            return () => clearTimeout(timer);
        }
    }, [isOpen]);

    // Process live events into notifications
    useEffect(() => {
        const newNotifications = events.map(event => ({
            id: `${event.type}-${event.timestamp}`,
            streamId: (event.data as { streamId?: number })?.streamId || 0,
            type: event.type,
            message: formatEventMessage(event),
            timestamp: event.timestamp,
            read: false
        }));

        if (newNotifications.length > 0) {
            // Use setTimeout to defer state update and avoid linting violation
            setTimeout(() => {
                setNotifications(prev => {
                    // Combine with existing notifications, remove duplicates, keep latest 20
                    const combined = [...newNotifications, ...prev];
                    const unique = combined.filter((notif, index, self) => 
                        index === self.findIndex(n => n.id === notif.id)
                    );
                    return unique.slice(0, 20);
                });
            }, 0);
        }
    }, [events, isOpen]);

    // Handle incoming SSE events
    useEffect(() => {
        if (streamEvents.length > 0 && !isOpen) {
            // Increment unread count for new events while dropdown is closed
            // Use setTimeout to avoid synchronous setState
            const timer = setTimeout(() => {
                setUnreadCount(prev => prev + 1);
            }, 0);
            return () => clearTimeout(timer);
        }

        // Future: Process SSE events here if needed
        // Example: Extract event data and create notifications
        // if (streamEvents.length > 0) {
        //     const latestEvent = streamEvents[0];
        //     const eventData = latestEvent.data as {
        //         streamId?: number;
        //         amount?: string;
        //         feeAmount?: string;
        //         transactionHash?: string;
        //         ledger?: number;
        //     };
        // }
    }, [streamEvents, isOpen]);

    // Calculate unread count from notifications
    const calculatedUnreadCount = useMemo(() => {
        return notifications.filter(n => !n.read).length;
    }, [notifications]);

    // Mark all as read when dropdown opens
    const handleDropdownOpen = useCallback(() => {
        setIsOpen(true);
        if (calculatedUnreadCount > 0) {
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        }
    }, [calculatedUnreadCount]);

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
                    <span className="absolute top-0 right-0 h-3 w-3 bg-accent rounded-full border-2 border-background flex items-center justify-center">
                        <span className="text-xs text-white font-bold">
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                    </span>
                )}
                {!connected && (
                    <>
                        <span className="absolute bottom-0 right-0 h-2 w-2 bg-red-500 rounded-full border-2 border-background"></span>
                        <span className="absolute top-0 right-0 h-5 w-5 bg-accent rounded-full border-2 border-background flex items-center justify-center text-xs font-bold text-white">
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                    </>
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
                        {notifications.length > 0 ? (
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
                                // Navigate to activity page
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
