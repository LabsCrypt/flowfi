"use client";

import React, { useState, useEffect } from 'react';

export const MobileMockup = () => {
    const [streamedAmount, setStreamedAmount] = useState(12540.00);

    useEffect(() => {
        const interval = setInterval(() => {
            setStreamedAmount(prev => prev + 0.00042);
        }, 100);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="relative mx-auto w-[280px] h-[580px] md:w-[320px] md:h-[640px] animate-float">
            {/* Phone Case/Outer Frame */}
            <div className="absolute inset-0 rounded-[3rem] border-[8px] border-slate-800 bg-black shadow-2xl overflow-hidden ring-1 ring-white/10">
                {/* Screen Content */}
                <div className="relative h-full w-full bg-[#050510] flex flex-col pt-12 px-6">
                    {/* Status Bar / Notch */}
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-full z-20 flex items-center justify-center">
                        <div className="w-10 h-2 bg-white/10 rounded-full"></div>
                    </div>

                    <header className="mb-8 mt-2">
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Available Balance</h4>
                        <div className="text-3xl font-black text-white mt-1">$42,910.45</div>
                    </header>

                    <div className="flex-1 space-y-6">
                        {/* Main Stream Card */}
                        <div className="p-5 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm">
                            <div className="flex justify-between items-center mb-4">
                                <span className="text-[10px] font-bold text-accent uppercase">Live Streaming</span>
                                <div className="flex gap-1">
                                    <div className="w-1 h-1 rounded-full bg-accent animate-pulse"></div>
                                    <div className="w-1 h-1 rounded-full bg-accent animate-pulse [animation-delay:0.2s]"></div>
                                </div>
                            </div>
                            <div className="text-2xl font-black text-white font-mono">
                                ${streamedAmount.toLocaleString(undefined, { minimumFractionDigits: 5, maximumFractionDigits: 5 })}
                            </div>
                            <div className="mt-4 flex items-center gap-3">
                                <div className="h-8 w-8 rounded-full bg-accent/20 flex items-center justify-center text-accent">
                                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" /></svg>
                                </div>
                                <div>
                                    <div className="text-[10px] font-bold text-white">To: Alex Rivera</div>
                                    <div className="text-[10px] text-slate-500">Salary Stream • Active</div>
                                </div>
                            </div>
                        </div>

                        {/* Smaller Cards */}
                        <div className="space-y-4">
                            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-full bg-accent-secondary/20 flex items-center justify-center text-accent-secondary">
                                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4zm14 5H2v5a2 2 0 002 2h12a2 2 0 002-2V9zm-5 4h-2a1 1 0 110-2h2a1 1 0 110 2z" /></svg>
                                    </div>
                                    <div className="text-[10px] font-bold text-white">Marketing Grant</div>
                                </div>
                                <span className="text-[10px] font-mono text-slate-400">0.05 / sec</span>
                            </div>

                            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-full bg-accent-tertiary/20 flex items-center justify-center text-accent-tertiary">
                                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" /></svg>
                                    </div>
                                    <div className="text-[10px] font-bold text-white">Referral Rewards</div>
                                </div>
                                <span className="text-[10px] font-mono text-slate-400">0.01 / sec</span>
                            </div>
                        </div>
                    </div>

                    <div className="mt-auto mb-8 p-4 bg-accent rounded-xl text-center shadow-lg shadow-accent/20">
                        <span className="text-xs font-black text-background">WITHDRAW BALANCE</span>
                    </div>
                </div>
            </div>

            {/* External decorative glow */}
            <div className="absolute -inset-10 bg-accent opacity-20 blur-[80px] -z-10 rounded-full animate-pulse-slow"></div>
        </div>
    );
};
