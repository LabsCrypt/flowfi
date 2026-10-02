"use client";

import { useState } from "react";
import { X, Copy, Check, QrCode } from "lucide-react";
import { Button } from "../ui/Button";
import toast from "react-hot-toast";

interface ShareAddressModalProps {
  address: string;
  onClose: () => void;
}

export function ShareAddressModal({ address, onClose }: ShareAddressModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success("Address copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass-card max-w-md w-full p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-lg hover:bg-white/10 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/20 mb-4">
            <QrCode className="h-8 w-8 text-accent" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Share Payment Address</h2>
          <p className="text-slate-400 text-sm">
            Share this address with anyone who wants to send you streaming payments
          </p>
        </div>

        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-black/40 border border-white/10">
            <p className="text-xs text-slate-400 mb-2">Your Stellar Address</p>
            <p className="font-mono text-sm break-all">{address}</p>
          </div>

          <Button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-2"
            glow
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy Address
              </>
            )}
          </Button>

          <div className="pt-4 border-t border-white/10">
            <h3 className="text-sm font-semibold mb-2">How it works</h3>
            <ul className="space-y-2 text-sm text-slate-400">
              <li className="flex gap-2">
                <span className="text-accent">•</span>
                <span>Senders use this address to create streams to you</span>
              </li>
              <li className="flex gap-2">
                <span className="text-accent">•</span>
                <span>Funds flow continuously over time, not as lump sums</span>
              </li>
              <li className="flex gap-2">
                <span className="text-accent">•</span>
                <span>Withdraw available funds anytime from your dashboard</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
