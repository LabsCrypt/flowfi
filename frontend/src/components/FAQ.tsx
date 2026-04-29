import React from 'react';
import { Card } from './ui/Card';

const faqs = [
    {
        q: 'How safe are the smart contracts?',
        a: 'FlowFi uses battle-tested, non-upgradable smart contracts. We have been audited by top-tier firms including OpenZeppelin and ConsenSys Diligence.',
    },
    {
        q: 'Which chains do you support?',
        a: 'We are currently live on Ethereum Mainnet, Arbitrum, and Optimism. Polygon and Base support is coming in Q3 2026.',
    },
    {
        q: 'Can recipients withdraw at any time?',
        a: 'Yes, recipients can withdraw their unlocked balance at any time, down to the second. There is no waiting period.',
    },
];

export const FAQ = () => {
    return (
        <section id="faq" className="py-32 px-6 md:px-12 bg-slate-900/30">
            <div className="mx-auto max-w-4xl">
                <h2 className="text-4xl font-black text-center mb-16">Frequently Asked Questions</h2>
                <div className="space-y-6">
                    {faqs.map((faq, i) => (
                        <Card key={i} hover={false} className="p-8 border-glass-highlight bg-white/[0.03]">
                            <h3 className="text-xl font-bold mb-3 flex gap-4">
                                <span className="text-accent">Q:</span> {faq.q}
                            </h3>
                            <p className="text-slate-400 leading-relaxed pl-9">
                                {faq.a}
                            </p>
                        </Card>
                    ))}
                </div>
            </div>
        </section>
    );
};
