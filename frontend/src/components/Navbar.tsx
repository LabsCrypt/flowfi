"use client";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { NotificationDropdown } from "./NotificationDropdown";
import Link from "next/link";
import { useWallet } from "@/context/wallet-context";
import { ModeToggle } from "./ModeToggle";
import { WalletButton } from "./wallet/WalletButton";
import { useModalDialog } from "@/hooks/useModalDialog";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/streams/create", label: "Create Stream" },
  { href: "/settings", label: "Settings" },
];

export const Navbar = () => {
  const { session, status } = useWallet();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 backdrop-blur-md border-b border-glass-border bg-background/50">
      <div className="flex items-center justify-between px-6 py-4 md:px-12">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.2)]">
            <svg
              className="h-6 w-6 text-background"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <span className="text-2xl font-black tracking-tighter text-white">
            FlowFi
          </span>
        </div>

        <div className="hidden items-center gap-8 text-sm font-semibold text-slate-400 md:flex">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="transition-colors hover:text-accent">
              {link.label}
            </Link>
          ))}
          <ModeToggle />
        </div>

        <div className="flex items-center gap-4">
          {status === "connected" && session?.publicKey && (
            <NotificationDropdown publicKey={session.publicKey} />
          )}
          <WalletButton />
          <button
            type="button"
            aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={isMobileMenuOpen}
            onClick={() => setIsMobileMenuOpen((open) => !open)}
            className="md:hidden text-slate-400 hover:text-accent transition-colors"
          >
            {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {isMobileMenuOpen && (
        <MobileMenu onClose={() => setIsMobileMenuOpen(false)} />
      )}
    </nav>
  );
};

const MobileMenu = ({ onClose }: { onClose: () => void }) => {
  const dialogRef = useModalDialog({ onClose });

  return (
    <div
      ref={dialogRef}
      data-testid="mobile-menu"
      className="flex flex-col gap-4 px-6 pb-4 text-sm font-semibold text-slate-400 md:hidden"
    >
      {NAV_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="transition-colors hover:text-accent"
          onClick={onClose}
        >
          {link.label}
        </Link>
      ))}
      <ModeToggle />
    </div>
  );
};
