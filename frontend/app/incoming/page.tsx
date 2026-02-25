"use client";

import IncomingStreams from "../../components/IncomingStreams";
import { Navbar } from "@/components/Navbar";
import { useWallet } from "@/context/wallet-context";
import React, { useEffect, useState } from "react";
import { fetchDashboardData, type Stream } from "@/lib/dashboard";

export default function IncomingPage() {
    const { session, status } = useWallet();
    const [streams, setStreams] = useState<Stream[]>([]);
    const [loading, setLoading] = useState(true);
    const [prevKey, setPrevKey] = useState(session?.publicKey);

    // Reset loading state if public key changes (preferred over useEffect for this)
    if (session?.publicKey !== prevKey) {
        setPrevKey(session?.publicKey);
        setLoading(true);
    }

    useEffect(() => {
        if (session?.publicKey) {
            fetchDashboardData(session.publicKey)
                .then(data => setStreams(data.incomingStreams))
                .catch(err => console.error("Failed to fetch incoming streams:", err))
                .finally(() => setLoading(false));
        }
    }, [session?.publicKey]);

    return (
        <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
            <Navbar />
            <main className="flex-1 py-12 relative z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    {status !== "connected" ? (
                        <div className="text-center py-20 bg-white/5 rounded-3xl backdrop-blur-xl border border-white/10">
                            <h2 className="text-2xl font-bold mb-4">Wallet Not Connected</h2>
                            <p className="text-slate-400">Please connect your wallet in the app to view your incoming streams.</p>
                        </div>
                    ) : loading ? (
                        <div className="text-center py-20">
                            <div className="spinner mx-auto mb-4"></div>
                            <p>Loading incoming streams...</p>
                        </div>
                    ) : (
                        <IncomingStreams streams={streams} />
                    )}
                </div>
            </main>
        </div>
    );
}
