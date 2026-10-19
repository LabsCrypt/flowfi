"use client";

import { useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import toast from "react-hot-toast";
import { copyToClipboard } from "@/lib/clipboard";
import { WEBHOOK_EVENT_TYPES, type WebhookSubscription } from "@/lib/api/webhooks";

interface Props {
  userAddress: string;
  subscription?: WebhookSubscription;
  secretKey?: string;
  onClose: () => void;
  onSave: (data: { targetUrl: string; eventTypes: string[] }) => Promise<void>;
  onRegenerate?: () => Promise<string>;
}

export function WebhookModal({ userAddress: _userAddress, subscription, secretKey, onClose, onSave, onRegenerate }: Props) {
  const [targetUrl, setTargetUrl] = useState(subscription?.targetUrl ?? "");
  const [events, setEvents] = useState<string[]>(subscription?.eventTypes ?? [...WEBHOOK_EVENT_TYPES]);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const validUrl = /^https:\/\/[^\s]+$/i.test(targetUrl);

  const submit = async () => {
    if (!validUrl || events.length === 0) return;
    setSaving(true);
    try { await onSave({ targetUrl, eventTypes: events }); } finally { setSaving(false); }
  };

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
    <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-950 p-6 text-white shadow-2xl">
      <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{subscription ? "Edit webhook" : "Register webhook"}</h2><button onClick={onClose} aria-label="Close"><X /></button></div>
      <label className="mt-6 block text-sm font-medium" htmlFor="webhook-url">HTTPS endpoint</label>
      <input id="webhook-url" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://api.example.com/flowfi" className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 outline-none focus:border-emerald-400" />
      {targetUrl && !validUrl && <p className="mt-1 text-xs text-rose-400">Enter a valid HTTPS URL.</p>}
      <fieldset className="mt-5"><legend className="text-sm font-medium">Events</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{WEBHOOK_EVENT_TYPES.map((event) => <label key={event} className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={events.includes(event)} onChange={() => setEvents((current) => current.includes(event) ? current.filter((item) => item !== event) : [...current, event])} />{event}</label>)}</div></fieldset>
      {secretKey && <div className="mt-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3"><p className="text-xs text-amber-200">Copy this signing secret now. It will not be shown again.</p><div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{secretKey}</code><button onClick={async () => { if (await copyToClipboard(secretKey)) { setCopied(true); toast.success("Secret copied"); } }} aria-label="Copy secret">{copied ? <Check size={16} /> : <Copy size={16} />}</button>{onRegenerate && <button onClick={async () => { const next = await onRegenerate(); if (next) toast.success("Secret regenerated"); }} aria-label="Regenerate secret"><RefreshCw size={16} /></button>}</div></div>}
      <div className="mt-6 flex justify-end gap-2"><button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-300">Cancel</button><button disabled={!validUrl || events.length === 0 || saving} onClick={() => void submit()} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{saving ? "Saving..." : "Save webhook"}</button></div>
    </div>
  </div>;
}