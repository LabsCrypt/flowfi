import React from 'react';
import { Card } from './ui/Card';

const featureList = [
    {
        title: 'Per-Second Streaming',
        description: 'Capital should never be idle. Stream payments every second directly to wallets, giving your team immediate liquidity.',
        icon: (
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
        ),
        accent: 'text-accent',
        bg: 'bg-accent/10',
    },
    {
        title: 'Zero Overhead',
        description: 'Automate your entire payroll and token distribution. One-click setup for recurring streams that manage themselves.',
        icon: (
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
        ),
        accent: 'text-accent-secondary',
        bg: 'bg-accent-secondary/10',
    },
    {
        title: 'Institutional Grade',
        description: 'Battle-tested smart contracts and comprehensive dashboards. Full audit trails and gas-optimized on L2 networks.',
        icon: (
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
        ),
        accent: 'text-accent-tertiary',
        bg: 'bg-accent-tertiary/10',
    },
];

export const Features = () => {
    return (
        <section id="features" className="py-32 px-6 md:px-12 bg-slate-900/30">
            <div className="mx-auto max-w-6xl">
                <div className="mb-20 text-center">
                    <h2 className="text-4xl font-black md:text-5xl">Engineered for Performance</h2>
                    <p className="mt-5 text-lg text-slate-400 max-w-2xl mx-auto">
                        FlowFi provides the underlying infrastructure for modern financial operations, optimized for speed and security.
                    </p>
                </div>

                <div className="grid gap-8 md:grid-cols-3">
                    {featureList.map((f, i) => (
                        <Card key={i} glow={i === 1} className="flex flex-col p-8 group">
                            <div className={`mb-8 flex h-14 w-14 items-center justify-center rounded-2xl ${f.bg} ${f.accent} transition-transform group-hover:scale-110 duration-300`}>
                                {f.icon}
                            </div>
                            <h3 className="mb-4 text-2xl font-bold">{f.title}</h3>
                            <p className="text-slate-400 leading-relaxed">
                                {f.description}
                            </p>
                        </Card>
                    ))}
                </div>
            </div>
        </section>
    );
};
