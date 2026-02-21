import type { Metadata } from "next";
import { IBM_Plex_Mono, Sora } from "next/font/google";
import React from "react";

import "./globals.css";
import { WalletProvider } from "@/context/wallet-context";
import Link from "next/link";


const sora = Sora({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "FlowFi | Real-time Payment Streams",
  description:
    "The trustless infrastructure to stream salaries, tokens, and rewards in real-time.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${sora.variable} ${mono.variable} antialiased`}>
        <WalletProvider>
          <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold text-blue-600">FlowFi</span>
              </div>
              <nav className="flex gap-6">
                <Link
                  href="/"
                  className="text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 transition-colors"
                >
                  Outgoing
                </Link>
                <Link
                  href="/incoming"
                  className="text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 transition-colors"
                >
                  Incoming
                </Link>
              </nav>
            </div>
          </header>
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
