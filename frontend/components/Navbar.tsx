import { NotificationDropdown } from "./NotificationDropdown";
import { useWallet } from "@/context/wallet-context";
import { Button } from "./ui/Button";
import { ModeToggle } from "./ModeToggle";
import { WalletButton } from "./wallet/WalletButton";

export const Navbar = () => {
  const { session, status } = useWallet();

  return (
    <nav className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 backdrop-blur-md md:px-12 border-b border-glass-border bg-background/50">
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
        <a href="#features" className="transition-colors hover:text-accent">
          Features
        </a>
        <a href="#how-it-works" className="transition-colors hover:text-accent">
          Process
        </a>
        <a href="#faq" className="transition-colors hover:text-accent">
          FAQ
        </a>
        <a href="#" className="transition-colors hover:text-accent">
          Ecosystem
        </a>
        <ModeToggle />
      </div>

      <div className="flex items-center gap-4">
        {status === "connected" && session?.publicKey && (
          <NotificationDropdown publicKey={session.publicKey} />
        )}
        <Button variant="ghost" className="hidden sm:inline-flex">
          Log In
        </Button>
        <WalletButton />
      </div>
    </nav>
  );
};
