export const Footer = () => {
    return (
        <footer className="border-t border-glass-border bg-background pt-32 pb-16 px-6 md:px-12 relative overflow-hidden">
            {/* Background glow */}
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-64 bg-accent opacity-10 blur-[120px] rounded-full pointer-events-none"></div>

            <div className="mx-auto max-w-6xl relative z-10">
                <div className="grid gap-16 md:grid-cols-4 mb-24">
                    <div className="col-span-1 md:col-span-2">
                        <div className="flex items-center gap-3 mb-8">
                            <div className="h-8 w-8 rounded-lg bg-accent flex items-center justify-center">
                                <svg className="h-5 w-5 text-background" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                            </div>
                            <span className="text-2xl font-black tracking-tighter">FlowFi</span>
                        </div>
                        <p className="max-w-sm text-lg text-slate-500 leading-relaxed mb-8">
                            The world’s most robust capital streaming protocol. Scale your financial operations with per-second precision.
                        </p>
                        <div className="flex gap-4">
                            <a href="#" className="h-10 w-10 glass-card flex items-center justify-center rounded-full hover:bg-accent/10 hover:text-accent transition-colors">
                                <span className="sr-only">Twitter</span>
                                <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24"><path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.84 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z" /></svg>
                            </a>
                            <a href="#" className="h-10 w-10 glass-card flex items-center justify-center rounded-full hover:bg-accent/10 hover:text-accent transition-colors">
                                <span className="sr-only">GitHub</span>
                                <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
                            </a>
                        </div>
                    </div>
                    <div>
                        <h4 className="mb-6 text-sm font-black uppercase tracking-widest text-white">Product</h4>
                        <ul className="space-y-4 text-sm font-semibold text-slate-500">
                            <li><a href="#" className="hover:text-accent transition-colors">Protocol v2</a></li>
                            <li><a href="#" className="hover:text-accent transition-colors">Ecosystem</a></li>
                            <li><a href="#" className="hover:text-accent transition-colors">Governance</a></li>
                            <li><a href="#" className="hover:text-accent transition-colors">Security</a></li>
                        </ul>
                    </div>
                    <div>
                        <h4 className="mb-6 text-sm font-black uppercase tracking-widest text-white">Resources</h4>
                        <ul className="space-y-4 text-sm font-semibold text-slate-500">
                            <li><a href="#" className="hover:text-accent transition-colors">Documentation</a></li>
                            <li><a href="#" className="hover:text-accent transition-colors">API Reference</a></li>
                            <li><a href="#" className="hover:text-accent transition-colors">Brand Assets</a></li>
                            <li><a href="#" className="hover:text-accent transition-colors">Support</a></li>
                        </ul>
                    </div>
                </div>

                <div className="pt-12 border-t border-glass-border flex flex-col items-center justify-between gap-6 md:flex-row text-xs font-bold text-slate-600 uppercase tracking-widest">
                    <p>© 2026 FlowFi Protocol. Built for the open internet.</p>
                    <div className="flex gap-10">
                        <a href="#" className="hover:text-accent transition-colors">Privacy</a>
                        <a href="#" className="hover:text-accent transition-colors">Terms</a>
                        <a href="#" className="hover:text-accent transition-colors">Cookies</a>
                    </div>
                </div>
            </div>
        </footer>
    );
};
