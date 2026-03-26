"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { Stream } from "@/lib/dashboard";
import { shortenPublicKey } from "@/lib/wallet";

interface StreamDetailsModalProps {
    stream: Stream;
    onClose: () => void;
    onCancelClick: () => void;
    onTopUpClick: () => void;
}

export const StreamDetailsModal: React.FC<StreamDetailsModalProps> = ({
    stream,
    onClose,
    onCancelClick,
    onTopUpClick,
}) => {
    // Escape key support
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
    }, [onClose]);

    const progress = (stream.withdrawn / stream.deposited) * 100;
    const remaining = stream.deposited - stream.withdrawn;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="glass-card relative w-full max-w-2xl mx-4 rounded-3xl border border-glass-border p-8 shadow-2xl animate-in fade-in zoom-in-95">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h2 className="text-2xl font-black tracking-tight">Stream Details</h2>
                        <p className="text-sm text-slate-400 font-mono">ID: {stream.id}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-full hover:bg-white/10 text-slate-400 transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Main Info */}
                    <div className="space-y-6">
                        <div className="p-4 rounded-2xl bg-white/5 border border-glass-border">
                            <label className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1 block">Recipient</label>
                            <div className="flex items-center gap-2">
                                <code className="text-sm text-accent truncate">{stream.recipient}</code>
                                <button
                                    onClick={() => navigator.clipboard.writeText(stream.recipient)}
                                    className="text-slate-500 hover:text-accent transition-colors"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="p-4 rounded-2xl bg-white/5 border border-glass-border">
                                <label className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1 block">Status</label>
                                <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-bold ${stream.status === 'Active' ? 'bg-green-500/20 text-green-400' :
                                        stream.status === 'Completed' ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                                    }`}>
                                    {stream.status}
                                </span>
                            </div>
                            <div className="p-4 rounded-2xl bg-white/5 border border-glass-border">
                                <label className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1 block">Token</label>
                                <span className="font-bold text-white">{stream.token}</span>
                            </div>
                        </div>

                        <div className="p-6 rounded-2xl border border-glass-border bg-gradient-to-br from-white/5 to-transparent">
                            <label className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-4 block">Streaming Progress</label>

                            <div className="flex justify-between items-end mb-2">
                                <span className="text-2xl font-black text-white">{stream.withdrawn}</span>
                                <span className="text-slate-400 text-sm">of {stream.deposited} {stream.token}</span>
                            </div>

                            <div className="h-3 w-full bg-slate-800 rounded-full overflow-hidden mb-3">
                                <div
                                    className="h-full bg-accent shadow-[0_0_15px_rgba(16,185,129,0.5)] transition-all duration-1000 ease-out"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>

                            <p className="text-sm text-slate-400">
                                {remaining} {stream.token} remaining to be streamed
                            </p>
                        </div>
                    </div>

                    {/* Actions & Meta */}
                    <div className="space-y-6">
                        <div className="p-4 rounded-2xl bg-white/5 border border-glass-border">
                            <label className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-1 block">Created On</label>
                            <p className="text-white font-medium">{stream.date}</p>
                        </div>

                        <div className="space-y-3 pt-4">
                            <p className="text-sm font-bold text-slate-400 px-1">Actions</p>
                            <Button
                                onClick={onTopUpClick}
                                disabled={stream.status !== 'Active'}
                                className="w-full justify-center h-12 text-lg"
                                glow
                            >
                                Add Funds
                            </Button>
                            <button
                                onClick={onCancelClick}
                                disabled={stream.status !== 'Active'}
                                className="w-full h-12 rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-all font-bold disabled:opacity-50 disabled:pointer-events-none active:scale-95"
                            >
                                Cancel Stream
                            </button>
                        </div>

                        <div className="p-4 rounded-2xl bg-red-500/5 border border-red-500/10 text-xs text-slate-400 italic">
                            Note: Cancelling a stream will return any unspent funds ({remaining} {stream.token}) to your wallet. This action cannot be undone.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
