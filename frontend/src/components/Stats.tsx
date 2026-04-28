import React from 'react';

const stats = [
    { label: 'Total Value Locked', value: '$240M+', gradient: 'text-gradient' },
    { label: 'Active Streams', value: '85k+', gradient: 'text-white' },
    { label: 'Network Savings', value: '$4.2M', gradient: 'text-gradient-secondary' },

];

export const Stats = () => {
    return (
        <section className="py-20 border-y border-glass-border bg-background relative z-10">
            <div className="mx-auto max-w-6xl px-6 md:px-12">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-12 text-center">
                    {stats.map((stat, i) => (
                        <div key={i} className="flex flex-col items-center">
                            <span className={`text-4xl md:text-5xl font-black tracking-tighter ${stat.gradient}`}>
                                {stat.value}
                            </span>
                            <span className="mt-3 text-xs md:text-sm font-bold uppercase tracking-[0.2em] text-slate-500">
                                {stat.label}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
};
