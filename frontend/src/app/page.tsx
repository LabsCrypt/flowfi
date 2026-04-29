import Link from "next/link";

import { FAQ } from "@/components/FAQ";
import { Features } from "@/components/Features";
import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Navbar } from "@/components/Navbar";
import { Stats } from "@/components/Stats";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-[10%] -left-[10%] h-[50%] w-[50%] animate-pulse-slow rounded-full bg-accent opacity-10 blur-[140px]"></div>
        <div className="absolute top-[30%] -right-[10%] h-[40%] w-[40%] animate-pulse-slow rounded-full bg-accent-secondary opacity-5 blur-[120px] [animation-delay:2s]"></div>
        <div className="absolute -bottom-[10%] left-[20%] h-[30%] w-[30%] animate-pulse-slow rounded-full bg-accent-tertiary opacity-5 blur-[100px] [animation-delay:4s]"></div>
      </div>

      <Navbar />

      <main className="relative z-10 flex-1">
        <Hero />
        <Stats />
        <Features />
        <HowItWorks />

        <section className="relative overflow-hidden px-6 py-40 text-center">
          <div className="absolute inset-0 bg-accent/5 opacity-50"></div>
          <div className="glass-card relative z-10 mx-auto max-w-5xl rounded-[2.5rem] border-accent/20 p-16 md:p-32">
            <h2 className="mb-8 text-5xl leading-tight font-black md:text-7xl">
              Ready to build the <br />
              <span className="text-gradient">Money Network?</span>
            </h2>
            <p className="mx-auto mt-8 max-w-xl text-xl font-medium text-slate-400">
              Join the hundreds of protocol builders and DAOs who have already
              switched to real-time capital allocation.
            </p>
            <div className="mt-14 flex flex-col justify-center gap-6 sm:flex-row">
              <Link
                href="/app"
                className="inline-flex h-14 items-center justify-center rounded-full bg-accent px-10 text-lg font-bold text-background shadow-[0_0_20px_rgba(16,185,129,0.4)] transition-all hover:shadow-[0_0_30px_rgba(16,185,129,0.6)] active:scale-95"
              >
                Launch App
              </Link>
              <button className="h-14 rounded-full border border-glass-border bg-glass px-10 text-lg font-bold backdrop-blur-xl transition-all hover:bg-white/5 active:scale-95">
                Contact Sales
              </button>
            </div>
          </div>
        </section>

        <FAQ />
      </main>

      <Footer />
    </div>
  );
}
