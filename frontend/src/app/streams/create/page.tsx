"use client";

import React, { useState } from "react";
import { 
  createStream, 
  toBaseUnits, 
  toDurationSeconds, 
  getTokenAddress, 
  toSorobanErrorMessage 
} from "@/lib/soroban";
import { hasValidPrecision, formatRate, toStroops } from "@/utils/amount";
import { toast } from "react-hot-toast";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useWallet } from "@/context/wallet-context";

export default function CreateStreamPage() {
  const { status, session } = useWallet();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [txState, setTxState] = useState<"idle" | "signing" | "submitted" | "confirming">("idle");
  const [formData, setFormData] = useState({
    recipient: "",
    token: "XLM",
    amount: "",
    duration: "30", // days
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status !== "connected" || !session) {
      toast.error("Please connect your wallet first.");
      return;
    }

    setLoading(true);
    setTxState("signing");

    try {
      const amountBigInt = toBaseUnits(formData.amount);
      const durationBigInt = toDurationSeconds(formData.duration, "days");
      const tokenAddress = getTokenAddress(formData.token);

      const result = await createStream(session, {
        recipient: formData.recipient,
        tokenAddress,
        amount: amountBigInt,
        durationSeconds: durationBigInt,
      });

      if (result.success) {
        setTxState("confirming");
        toast.success("Stream created successfully!");
        // Small delay to allow indexer to catch up
        setTimeout(() => {
          router.push("/dashboard");
        }, 2000);
      }
    } catch (error) {
      console.error("Stream creation failed:", error);
      toast.error(toSorobanErrorMessage(error));
    } finally {
      setLoading(false);
      setTxState("idle");
    }
  };

  const getButtonText = () => {
    if (!loading) return "Start Streaming";
    switch (txState) {
      case "signing": return "Confirm in Wallet...";
      case "submitted": return "Submitting to Network...";
      case "confirming": return "Finalizing Stream...";
      default: return "Processing...";
    }
  };

  return (
    <div className="container mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/dashboard"
        className="mb-8 inline-flex items-center text-sm font-medium text-slate-400 hover:text-white transition-colors"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Dashboard
      </Link>

      <div className="glass-card rounded-3xl border-slate-800 p-8">
        <h1 className="mb-2 text-3xl font-bold">Create New Stream</h1>
        <p className="mb-8 text-slate-400">
          Set up a real-time payment stream to any Stellar address.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300">
              Recipient Address
            </label>
            <input
              type="text"
              placeholder="G..."
              className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors"
              value={formData.recipient}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, recipient: e.target.value })}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">
                Token
              </label>
              <select
                className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors appearance-none"
                value={formData.token}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, token: e.target.value })}
              >
                <option value="XLM">XLM</option>
                <option value="USDC">USDC</option>
                <option value="FLOW">FLOW</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">
                Total Amount
              </label>
              <input
                type="number"
                placeholder="0.00"
                className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors"
                value={formData.amount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const val = e.target.value;
                  if (hasValidPrecision(val, 7)) {
                    setFormData({ ...formData, amount: val });
                  }
                }}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300">
              Duration (Days)
            </label>
            <input
              type="number"
              placeholder="30"
              className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-4 outline-none focus:border-accent transition-colors"
              value={formData.duration}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, duration: e.target.value })}
              required
            />
          </div>

          <div className="rounded-2xl bg-accent/5 p-6 space-y-4">
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Streaming Rate</span>
              <span className="font-mono font-medium text-accent">
                {formData.amount && formData.duration 
                  ? formatRate(toStroops(formData.amount, 7) / toDurationSeconds(formData.duration, "days"), 7, formData.token)
                  : "0.00000000 " + formData.token + "/sec"}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-400">Estimated End Date</span>
              <span className="font-medium">
                {new Date(Date.now() + Number(formData.duration || 0) * 86400000).toLocaleDateString()}
              </span>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || status !== "connected"}
            className="w-full rounded-xl bg-accent py-4 text-lg font-bold text-background transition-all hover:opacity-90 disabled:opacity-50 active:scale-[0.98]"
          >
            {getButtonText()}
          </button>
          
          {status !== "connected" && (
            <p className="text-center text-sm text-red-400">
              Please connect your wallet to create a stream.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
