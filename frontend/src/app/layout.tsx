import type { Metadata } from "next";
import { IBM_Plex_Mono, Sora } from "next/font/google";
import React from "react";

import "./globals.css";
import { WalletProvider } from "@/context/wallet-context";
import { Toaster } from "react-hot-toast";
import { ThemeProvider } from "@/context/theme-provider";
import { Navbar } from "@/components/Navbar";
import { QueryProvider } from "@/components/providers/query-provider";

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
    <html lang="en" suppressHydrationWarning>
      <body className={`${sora.variable} ${mono.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          enableSystem={false}
          disableTransitionOnChange
        >
          <QueryProvider>
            <WalletProvider>
              <Navbar />
              <Toaster
                position="top-right"
                toastOptions={{
                  duration: 4000,
                  style: {
                    background: "#111",
                    color: "#fff",
                    border: "1px solid #333",
                    borderRadius: "12px",
                  },
                }}
              />
              {children}
            </WalletProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
