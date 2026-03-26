"use client";

import OutgoingStreams from "../../components/OutgoingStreams";
import { Navbar } from "@/components/Navbar";
import { useWallet } from "@/context/wallet-context";
import React, { useEffect, useState } from "react";
import { fetchDashboardData, type Stream } from "@/lib/dashboard";
import toast from "react-hot-toast";

// Mock outgoing streams data for development
const mockOutgoingStreams: Stream[] = [
    {
        id: "1",
        recipient: "GABC123...XYZ",
        amount: 1000,
        token: "XLM",
        status: "Active",
        deposited: 1000,
        withdrawn: 250,
        date: "2024-01-15",
        ratePerSecond: 0.0001,
        lastUpdateTime: Date.now() / 1000,
        isActive: true,
    },
    {
        id: "2",
        recipient: "GDEF456...ABC",
        amount: 500,
        token: "XLM",
        status: "Active",
        deposited: 500,
        withdrawn: 100,
        date: "2024-01-20",
        ratePerSecond: 0.00005,
        lastUpdateTime: Date.now() / 1000,
        isActive: true,
    },
    {
        id: "3",
        recipient: "GHI789...DEF",
        amount: 750,
        token: "XLM",
        status: "Paused",
        deposited: 750,
        withdrawn: 300,
        date: "2024-01-10",
        ratePerSecond: 0.00008,
        lastUpdateTime: Date.now() / 1000,
        isActive: false,
    },
    {
        id: "4",
        recipient: "JKL012...GHI",
        amount: 2000,
        token: "XLM",
        status: "Completed",
        deposited: 2000,
        withdrawn: 2000,
        date: "2024-01-05",
        ratePerSecond: 0.0002,
        lastUpdateTime: Date.now() / 1000,
        isActive: false,
    },
];

export default function OutgoingPage() {
    const { session, status } = useWallet();
    const [streams, setStreams] = useState<Stream[]>([]);
    const [loading, setLoading] = useState(true);
    const [prevKey, setPrevKey] = useState(session?.publicKey);
    const [cancelingStreamId, setCancelingStreamId] = useState<string | null>(null);
    const [modifyingStreamId, setModifyingStreamId] = useState<string | null>(null);

    // Reset loading state if public key changes
    if (session?.publicKey !== prevKey) {
        setPrevKey(session?.publicKey);
        setLoading(true);
    }

    useEffect(() => {
        if (session?.publicKey) {
            // For now, use mock data. In production, this would fetch from the backend
            setLoading(true);
            setTimeout(() => {
                setStreams(mockOutgoingStreams);
                setLoading(false);
            }, 1000);
            
            // Uncomment this line when backend is ready
            /*
            fetchDashboardData(session.publicKey)
                .then(data => setStreams(data.outgoingStreams))
                .catch(err => console.error("Failed to fetch outgoing streams:", err))
                .finally(() => setLoading(false));
            */
        } else {
            // Show mock data even when not connected for demo purposes
            setStreams(mockOutgoingStreams);
            setLoading(false);
        }
    }, [session?.publicKey]);

    const handleCancel = async (stream: Stream) => {
        setCancelingStreamId(stream.id);
        try {
            // Simulate API call
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Update the stream status to cancelled
            setStreams(prev => prev.map(s => 
                s.id === stream.id 
                    ? { ...s, status: "Cancelled" as const, isActive: false }
                    : s
            ));
            
            toast.success(`Stream to ${stream.recipient} has been cancelled`);
        } catch (error) {
            console.error("Failed to cancel stream:", error);
            toast.error("Failed to cancel stream");
        } finally {
            setCancelingStreamId(null);
        }
    };

    const handleModify = async (stream: Stream) => {
        setModifyingStreamId(stream.id);
        try {
            // Simulate API call for modification
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            toast.success(`Stream to ${stream.recipient} modification dialog would open here`);
            // In a real implementation, this would open a modal to modify stream parameters
        } catch (error) {
            console.error("Failed to modify stream:", error);
            toast.error("Failed to modify stream");
        } finally {
            setModifyingStreamId(null);
        }
    };

    return (
        <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
            <Navbar />
            <main className="flex-1 py-12 relative z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    {status !== "connected" ? (
                        <div className="text-center py-20 bg-white/5 rounded-3xl backdrop-blur-xl border border-white/10">
                            <h2 className="text-2xl font-bold mb-4">Wallet Not Connected</h2>
                            <p className="text-slate-400">Please connect your wallet in the app to view your outgoing streams.</p>
                            <p className="text-slate-500 mt-2 text-sm">Showing demo data for preview purposes.</p>
                        </div>
                    ) : loading ? (
                        <div className="text-center py-20">
                            <div className="spinner mx-auto mb-4"></div>
                            <p>Loading outgoing streams...</p>
                        </div>
                    ) : (
                        <OutgoingStreams
                            streams={streams}
                            onCancel={handleCancel}
                            onModify={handleModify}
                            cancelingStreamId={cancelingStreamId}
                            modifyingStreamId={modifyingStreamId}
                        />
                    )}
                </div>
            </main>
        </div>
    );
}
