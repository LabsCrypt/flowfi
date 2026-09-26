/**
 * Marketing copy for the "how it works" section lives in the typed `STEPS`
 * array below rather than inline in the JSX. Keeping the content separate from
 * the layout means copy edits (or a future i18n pass, where each field becomes
 * a translation key lookup) only touch the data array — never the component.
 */
interface HowItWorksStep {
    /** Display-only ordinal shown next to the step title, e.g. "01". */
    number: string;
    title: string;
    description: string;
}

const STEPS: readonly HowItWorksStep[] = [
    {
        number: '01',
        title: 'Connect & Configure',
        description: 'Link your treasury wallet and select the assets you want to stream. We support XLM, USDC, EURC, and other Stellar token contracts.',
    },
    {
        number: '02',
        title: 'Define Parameters',
        description: 'Set the stream duration, total amount, and recipient address. Preview the real-time flow before launching.',
    },
    {
        number: '03',
        title: 'Stream is Live',
        description: 'Recipients start receiving funds every second. You can pause, adjust, or cancel streams instantly.',
    },
];

/** Section heading copy, extracted alongside `STEPS` for the same reason. */
const SECTION_COPY = {
    heading: 'Stream Management',
    headingLineTwo: 'Made Simple',
    subheading:
        'FlowFi abstracts away the complexity of smart contracts, providing a seamless dashboard for all your streaming needs.',
};

export const HowItWorks = () => {
    return (
        <section id="how-it-works" className="py-32 px-6 md:px-12 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-96 h-96 bg-accent-secondary opacity-5 blur-[100px] rounded-full -mr-48"></div>

            <div className="mx-auto max-w-6xl">
                <div className="flex flex-col items-center md:flex-row md:justify-between md:items-end mb-20">
                    <div className="max-w-xl text-center md:text-left">
                        <h2 className="text-4xl font-black md:text-5xl">{SECTION_COPY.heading} <br /> {SECTION_COPY.headingLineTwo}</h2>
                        <p className="mt-6 text-lg text-slate-400">
                            {SECTION_COPY.subheading}
                        </p>
                    </div>
                    <div className="hidden md:block h-px flex-1 bg-gradient-to-r from-transparent via-glass-border to-transparent mx-12 mb-6"></div>
                </div>

                <div className="grid gap-12 md:grid-cols-3">
                    {STEPS.map((step, i) => (
                        <div key={step.number} className="relative group">
                            <div className="mb-6 flex items-baseline gap-4">
                                <span className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-b from-accent to-transparent opacity-40">
                                    {step.number}
                                </span>
                                <h3 className="text-2xl font-bold">{step.title}</h3>
                            </div>
                            <p className="text-lg text-slate-400 leading-relaxed pl-4 border-l-2 border-glass-border group-hover:border-accent transition-colors duration-300">
                                {step.description}
                            </p>
                            {i < STEPS.length - 1 && (
                                <div className="hidden md:block absolute top-10 -right-6 text-slate-700">
                                    <svg className="w-12 h-6" fill="none" stroke="currentColor" viewBox="0 0 48 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M0 12h46m0 0l-10-10m10 10l-10 10" />
                                    </svg>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
};
