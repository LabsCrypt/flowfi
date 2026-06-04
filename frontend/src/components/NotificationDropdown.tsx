"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useStreamEvents } from "@/hooks/useStreamEvents";
import { formatAmount } from "@/utils/amount";
import { Button } from "./ui/Button";

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
    const router = useRouter();
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);

    const { events: streamEvents, connected } = useStreamEvents({
        userPublicKeys: [publicKey],
        autoReconnect: true,
    });

    const formatEventMessage = useCallback((event: { type: string; data?: Record<string, unknown> }): string => {
        const data = (event.data || {}) as Record<string, unknown>;
        const streamId = (data.streamId as number) || 0;
        const amountStr = (data.amount as string) || "0";
        const amount = amountStr ? formatAmount(BigInt(amountStr), 7) : "0";
        const tokenSymbol = (data.tokenSymbol as string) || "USDC";
        const eventType = event.type.toLowerCase();

        switch (eventType) {
            case "created":
            case "stream.created":
                return `New stream #${streamId} created`;

            case "topped_up":
            case "stream.topped_up":
                return `Stream #${streamId} was topped up by ${amount} ${tokenSymbol}`;

            case "withdrawn":
            case "stream.withdrawn":
                return `You received ${amount} ${tokenSymbol} from stream #${streamId}`;

            case "cancelled":
            case "stream.cancelled":
                return `Stream #${streamId} was cancelled — refund incoming`;

            case "completed":
            case "stream.completed":
                return `Stream #${streamId} completed`;

            case "paused":
            case "stream.paused":
                return `Stream #${streamId} was paused`;

            case "resumed":
            case "stream.resumed":
                return `Stream #${streamId} was resumed`;

            case "fee_collected":
            case "stream.fee_collected":
                return `Fee collected from stream #${streamId}`;

            case "fee_config_updated":
            case "stream.fee_config_updated":
                return "Stream fee configuration was updated";

            case "admin_transferred":
            case "stream.admin_transferred":
                return "Stream admin role was transferred";

            default:
                return `Activity on stream #${streamId}`;
        }
    }, []);

    useEffect(() => {
        if (streamEvents.length === 0) return;

        const newNotifications = streamEvents.map((event) => ({
            id: `sse-${event.type}-${event.timestamp}`,
            streamId: ((event.data as Record<string, unknown>)?.streamId as number) || 0,
            type: event.type,
            message: formatEventMessage(event as { type: string; data?: Record<string, unknown> }),
            timestamp: event.timestamp,
            read: isOpen,
        }));

        queueMicrotask(() => {
            setNotifications((prev) => {
                const combined = [...newNotifications, ...prev];
                const unique = combined.filter(
                    (notif, index, self) => index === self.findIndex((n) => n.id === notif.id),
                );
                return unique.slice(0, 20);
            });

            if (!isOpen) {
                setUnreadCount((prev) => prev + newNotifications.length);
            }
        });
    }, [streamEvents, isOpen, formatEventMessage]);

    const handleDropdownOpen = useCallback(() => {
        setIsOpen((prev) => !prev);

        if (!isOpen) {
            setUnreadCount(0);
            setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
        }
    }, [isOpen]);

    return (
        <div className="relative">
            <button
                onClick={handleDropdownOpen}
                aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                className="relative p-2 text-slate-400 hover:text-accent transition-colors"
                disabled={!connected}
            >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                </svg>

                {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 h-5 w-5 bg-accent rounded-full border-2 border-background flex items-center justify-center text-xs font-bold text-white">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}

                {!connected && unreadCount === 0 && (
                    <span className="absolute bottom-0 right-0 h-2 w-2 bg-red-500 rounded-full border-2 border-background" />
                )}
            </button>

            {isOpen && (
                <div
                    role="dialog"
                    aria-label="Notifications"
                    className="absolute right-0 mt-2 w-80 bg-background/95 backdrop-blur-md border border-glass-border rounded-2xl shadow-2xl z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2"
                >
                    <div className="p-4 border-b border-glass-border flex justify-between items-center">
                        <h3 className="font-bold text-white">Notifications</h3>

                        <div className="flex items-center gap-2">
                            {!connected && <span className="text-xs text-red-400">Reconnecting...</span>}

                            <button
                                onClick={() => setIsOpen(false)}
                                aria-label="Close notifications"
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
                                        className={`p-4 hover:bg-white/5 transition-colors ${
                                            !notification.read ? "bg-white/2" : ""
                                        }`}
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
                                {connected ? "No new notifications" : "Connecting to live updates..."}
                            </div>
                        )}
                    </div>

                    <div className="p-3 border-t border-glass-border">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-xs"
                            onClick={() => {
                                setIsOpen(false);
                                router.push("/activity");
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