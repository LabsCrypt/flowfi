"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import toast from "react-hot-toast";
import type { Stream } from "@/lib/dashboard";
import { batchWithdrawFromStreams } from "@/lib/soroban";
import { useWallet } from "@/context/wallet-context";

function claimable(stream: Stream): number {
  if (!stream.isActive || stream.status !== "Active") return 0;
  const elapsed = Math.max(0, Date.now() / 1000 - stream.lastUpdateTime);
  return Math.min(Math.max(0, stream.deposited - stream.withdrawn), elapsed * stream.ratePerSecond);
}

export function BatchClaimDrawer({ streams, onClose, onSuccess }: { streams: Stream[]; onClose: () => void; onSuccess: () => Promise<void> | void }) {
  const { session } = useWallet(); const claimableStreams = useMemo(() => streams.map((stream) => ({ stream, amount: claimable(stream) })).filter((item) => item.amount > 0), [streams]); const [selected, setSelected] = useState(() => new Set(claimableStreams.map((item) => item.stream.id))); const [pending, setPending] = useState(false);
  const selectedItems = claimableStreams.filter((item) => selected.has(item.stream.id)); const totals = selectedItems.reduce<Record<string, number>>((result, item) => { result[item.stream.token] = (result[item.stream.token] ?? 0) + item.amount; return result; }, {});
  const submit = async () => { if (!session || selectedItems.length === 0) return; setPending(true); try { await batchWithdrawFromStreams(session, { streamIds: selectedItems.map((item) => BigInt(item.stream.id.replace(/\D/g, "") || "0")) }); toast.success("Batch claim submitted"); await onSuccess(); onClose(); } catch (error) { toast.error(error instanceof Error ? error.message : "Batch claim failed"); } finally { setPending(false); } };
  return <aside className="fixed inset-y-0 right-0 z-[55] flex w-full max-w-lg flex-col border-l border-white/10 bg-slate-950 p-6 text-white shadow-2xl" aria-label="Batch claim drawer"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-widest text-emerald-300">Incoming streams</p><h2 className="mt-1 text-2xl font-semibold">Batch claim</h2></div><button onClick={onClose} aria-label="Close batch claim"><X /></button></div><div className="mt-6 grid gap-2 sm:grid-cols-2">{Object.entries(totals).map(([token, amount]) => <div key={token} className="rounded-xl bg-white/5 p-4"><p className="text-xs text-slate-400">Ready to claim</p><p className="mt-1 text-xl font-semibold">{amount.toFixed(4)} {token}</p></div>)}</div><label className="mt-6 flex items-center gap-2 border-b border-white/10 pb-3 text-sm"><input type="checkbox" checked={selected.size === claimableStreams.length && claimableStreams.length > 0} onChange={(event) => setSelected(event.target.checked ? new Set(claimableStreams.map((item) => item.stream.id)) : new Set())} />Select all</label><div className="min-h-0 flex-1 overflow-y-auto">{claimableStreams.map(({ stream, amount }) => <label key={stream.id} className="flex items-center gap-3 border-b border-white/10 py-4"><input type="checkbox" checked={selected.has(stream.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(stream.id)) next.delete(stream.id); else next.add(stream.id); return next; })} /><span className="min-w-0 flex-1"><span className="block text-sm">Stream #{stream.id} · {stream.recipient}</span><span className="text-xs text-slate-400">{stream.token}</span></span><strong className="text-sm text-emerald-300">{amount.toFixed(4)}</strong></label>)}</div><div className="border-t border-white/10 pt-4"><p className="mb-3 text-sm text-slate-400">{selectedItems.length} streams selected</p><button disabled={!session || selectedItems.length === 0 || pending} onClick={() => void submit()} className="w-full rounded-lg bg-emerald-400 px-4 py-3 font-semibold text-slate-950 disabled:opacity-50">{pending ? "Confirming..." : `Claim selected (${selectedItems.length})`}</button></div></aside>;
}