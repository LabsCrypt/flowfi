import React from 'react';
import { Button } from './ui/Button';
import { MobileMockup } from './MobileMockup';

export const Hero = () => {
    return (
        <section className="relative flex flex-col items-center px-6 pt-24 pb-32 text-center lg:text-left md:px-12 lg:pt-40 overflow-hidden lg:flex-row lg:justify-between lg:max-w-7xl lg:mx-auto lg:gap-12">
            {/* Visual background element */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-5xl aspect-video opacity-20 pointer-events-none">
                <div className="absolute inset-0 bg-gradient-to-r from-accent via-accent-secondary to-accent-tertiary blur-[120px] rounded-full"></div>
            </div>

            <div className="relative z-10 max-w-5xl mx-auto flex flex-col items-center lg:items-start lg:w-3/5">
                <div className="inline-flex animate-fade-in items-center rounded-full border border-glass-highlight bg-white/5 px-4 py-1.5 text-xs font-bold text-accent shadow-xl backdrop-blur-xl">
                    <span className="mr-2 flex h-2 w-2 rounded-full bg-accent animate-pulse"></span>
                    NEW: v2.0 STREAMING PROTOCOL
                </div>

                <h1 className="mt-10 animate-slide-up text-5xl font-black tracking-tight md:text-7xl lg:text-8xl leading-[1.05]">
                    Real-time <br />
                    <span className="text-gradient">Payment Streams</span>
                </h1>

                <p className="mt-8 max-w-2xl animate-slide-up text-lg font-medium text-slate-400 md:text-xl lg:text-2xl leading-relaxed [animation-delay:0.1s]">
                    The trustless infrastructure to stream salaries, rewards, and multi-sig distributions in real-time. Reduce friction, eliminate gas waste, and unlock capital efficiency.
                </p>

                <div className="mt-12 flex animate-slide-up flex-col gap-5 sm:flex-row [animation-delay:0.2s] w-full justify-center lg:justify-start">
                    <Button variant="primary" size="lg" glow className="min-w-[200px]">
                        Start Streaming
                        <svg className="ml-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                        </svg>
                    </Button>
                    <Button variant="outline" size="lg" className="min-w-[200px]">
                        Governance App
                    </Button>
                </div>

                <div className="mt-20 flex items-center gap-4 animate-fade-in [animation-delay:0.4s]">
                    <div className="flex -space-x-2">
                        {[1, 2, 3, 4].map((i) => (
                            <div key={i} className="h-10 w-10 rounded-full border-2 border-background bg-slate-800 flex items-center justify-center overflow-hidden">
                                <div className={`h-full w-full bg-gradient-to-br from-slate-700 to-slate-900 border border-white/5`}></div>
                            </div>
                        ))}
                    </div>
                    <p className="text-sm font-medium text-slate-500">
                        Trusted by <span className="text-white font-bold">12,000+</span> protocol builders
                    </p>
                </div>
            </div>

            <div className="mt-20 lg:mt-0 relative z-10 lg:w-2/5 flex justify-center animate-slide-up [animation-delay:0.3s]">
                <MobileMockup />
            </div>
        </section>
    );
};
