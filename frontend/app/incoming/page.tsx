import IncomingStreams from "../../components/IncomingStreams";
import { Navbar } from "@/components/Navbar";

export default function IncomingPage() {
    return (
        <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
            <Navbar />
            <main className="flex-1 py-12 relative z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <IncomingStreams />
                </div>
            </main>
        </div>
    );
}
