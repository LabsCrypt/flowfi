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
  // suppressHydrationWarning allows the blocking inline script in <head> to
  // mutate the `dark` class on <html> without React logging a hydration
  // mismatch warning. See theme-provider.tsx for the full strategy.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Blocking inline script that reads the user's stored theme preference
          from localStorage and applies the `dark` class to <html> BEFORE the
          browser paints a single pixel. This prevents the flash-of-wrong-theme
          (FART) when the server renders a default theme class that differs from
          the user's persisted preference.

          The `suppressHydrationWarning` prop on <html> is the companion measure:
          after this script mutates the class, React will see a mismatch between
          server-rendered <html> (no `dark` class) and the client DOM (possibly
          `dark` class) and would normally emit a console warning.
          suppressHydrationWarning tells React to skip that check for this
          element because the discrepancy is intentional and resolved before
          hydration completes.

          Flow: inline script runs → class set → browser paints → React hydrates
          (suppressHydrationWarning) → next-themes ThemeProvider takes over.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('flowfi-theme') || 'dark';
                  if (theme === 'system') {
                    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  }
                  if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                  } else {
                    document.documentElement.classList.remove('dark');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className={`${sora.variable} ${mono.variable} antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={true}
          storageKey="flowfi-theme"
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
