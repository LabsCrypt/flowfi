import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Sora } from "next/font/google";
import React from "react";

import "./globals.css";
import { WalletProvider } from "@/context/wallet-context";
import { Toaster } from "react-hot-toast";
import { ThemeProvider } from "@/context/theme-provider";
import { I18nProvider } from "@/context/i18n-provider";
import { THEMES, THEME_STORAGE_KEY } from "@/lib/themes";
import { OfflineBanner } from "@/components/OfflineBanner";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Navbar } from "@/components/Navbar";
import { QueryProvider } from "@/components/providers/query-provider";
import { NetworkProvider } from "@/context/NetworkContext";
import { WalletMismatchBanner } from "@/components/wallet/WalletMismatchBanner";

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

export const viewport: Viewport = {
  themeColor: "#020617",
};

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "FlowFi", statusBarStyle: "black-translucent" },
  title: "FlowFi | Real-time Payment Streams",
  description:
    "The trustless infrastructure to stream salaries, tokens, and rewards in real-time.",
  metadataBase: new URL("https://flowfi.app"),
  openGraph: {
    title: "FlowFi | Real-time Payment Streams",
    description:
      "The trustless infrastructure to stream salaries, tokens, and rewards in real-time.",
    url: "https://flowfi.app",
    siteName: "FlowFi",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "FlowFi - Real-time Payment Streams",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FlowFi | Real-time Payment Streams",
    description:
      "The trustless infrastructure to stream salaries, tokens, and rewards in real-time.",
    images: ["/opengraph-image.png"],
  },
  alternates: {
    canonical: "https://flowfi.app",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /*
      `suppressHydrationWarning` is the companion to next-themes' built-in
      blocking pre-paint script (rendered by <ThemeProvider> below). The
      server renders <html> without a theme class; that script then reads the
      persisted theme from localStorage and adds/removes the theme class
      (`light`/`dark`) on <html> before the first paint, so the client DOM
      class list can legitimately differ from what the server rendered. This
      prop tells React to skip the hydration-difference check for this
      element because the divergence is intentional and resolved before paint.
      See `theme-provider.tsx` for the full strategy.
    */
    <html lang="en" suppressHydrationWarning>
      <head />
      <body className={`${sora.variable} ${mono.variable} antialiased`}>
        <ThemeProvider
          attribute={["class", "data-theme"]}
          themes={[...THEMES]}
          defaultTheme="dark"
          enableSystem={true}
          storageKey={THEME_STORAGE_KEY}
          disableTransitionOnChange
        >
          <I18nProvider>
          <QueryProvider>
            <NetworkProvider>
              <WalletProvider>
                <OfflineBanner />
                <ServiceWorkerRegistrar />
                <Navbar />
                <WalletMismatchBanner />
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
            </NetworkProvider>
          </QueryProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
