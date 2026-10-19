'use client';

import { useEffect, useState } from 'react';
import {
  getExistingSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/notifications/push';

export interface PushNotificationToggleProps {
  address: string;
}

export function PushNotificationToggle({ address }: PushNotificationToggleProps) {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isPushSupported());
    void getExistingSubscription()
      .then((sub) => setEnabled(Boolean(sub)))
      .catch(() => undefined);
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await unsubscribeFromPush(address);
        setEnabled(false);
      } else {
        await subscribeToPush(address);
        setEnabled(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update notifications');
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <p className="text-sm text-slate-500" data-testid="push-unsupported">
        Browser push notifications are not supported in this browser.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        data-testid="push-toggle"
        className="h-9 w-fit rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Updating…' : enabled ? 'Disable browser push' : 'Enable browser push'}
      </button>

      {error ? (
        <p role="alert" data-testid="push-error" className="text-xs text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default PushNotificationToggle;
