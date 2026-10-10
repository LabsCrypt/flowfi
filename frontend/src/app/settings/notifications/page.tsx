'use client';

import { useState } from 'react';
import { PushNotificationToggle } from '@/components/notifications/PushNotificationToggle';

export default function NotificationSettingsPage() {
  const [address, setAddress] = useState('');
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [discordUrl, setDiscordUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateCode = async () => {
    setError(null);
    setLinkCode(null);
    try {
      const res = await fetch('/api/v1/notifications/link-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) throw new Error('Failed to generate link code');
      const data = await res.json();
      setLinkCode(data.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const saveDiscord = async () => {
    setError(null);
    setStatus(null);
    try {
      const res = await fetch('/api/v1/notifications/discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, webhookUrl: discordUrl }),
      });
      if (!res.ok) throw new Error('Failed to save Discord webhook');
      setStatus('Discord webhook saved.');
      setDiscordUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Notification settings
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Receive alerts for new streams, cliffs, low runway, and withdrawals.
      </p>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Stellar address</h2>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="G..."
          data-testid="address-input"
          className="mt-2 h-9 w-full rounded-lg border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </section>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Browser push</h2>
        <div className="mt-2">
          <PushNotificationToggle address={address} />
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Telegram</h2>
        <p className="mt-1 text-xs text-slate-500">
          Generate a code, then open <strong>@FlowFiAlertsBot</strong> and send{' '}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">/link &lt;code&gt;</code>.
        </p>
        <button
          type="button"
          onClick={() => void generateCode()}
          data-testid="generate-link-code"
          className="mt-2 h-9 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Generate link code
        </button>
        {linkCode ? (
          <p className="mt-2 font-mono text-sm" data-testid="link-code">
            {linkCode}
          </p>
        ) : null}
      </section>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Discord webhook</h2>
        <input
          type="url"
          value={discordUrl}
          onChange={(e) => setDiscordUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
          data-testid="discord-input"
          className="mt-2 h-9 w-full rounded-lg border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={() => void saveDiscord()}
          data-testid="save-discord"
          className="mt-2 h-9 rounded-lg border border-slate-300 px-4 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Save webhook
        </button>
      </section>

      {status ? <p className="mt-4 text-sm text-emerald-600">{status}</p> : null}
      {error ? (
        <p className="mt-4 text-sm text-rose-600" data-testid="page-error">
          {error}
        </p>
      ) : null}
    </main>
  );
}
