import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { subscribeToPush, unsubscribeFromPush, getExistingSubscription } = vi.hoisted(() => ({
  subscribeToPush: vi.fn(async () => ({} as PushSubscription)),
  unsubscribeFromPush: vi.fn(async () => undefined),
  getExistingSubscription: vi.fn(async () => null as PushSubscription | null),
}));

vi.mock('@/lib/notifications/push', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications/push')>(
    '@/lib/notifications/push',
  );
  return {
    ...actual,
    isPushSupported: () => true,
    subscribeToPush,
    unsubscribeFromPush,
    getExistingSubscription,
  };
});

import { PushNotificationToggle } from '@/components/notifications/PushNotificationToggle';
import { urlBase64ToUint8Array } from '@/lib/notifications/push';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to the expected bytes', () => {
    // "hello" base64url = "aGVsbG8"
    const bytes = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles url-safe characters (- and _)', () => {
    const bytes = urlBase64ToUint8Array('a-_w');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe('PushNotificationToggle', () => {
  beforeEach(() => {
    subscribeToPush.mockClear();
    unsubscribeFromPush.mockClear();
    getExistingSubscription.mockClear();
    getExistingSubscription.mockResolvedValue(null);
  });

  it('renders an "Enable" button when no subscription exists', async () => {
    render(<PushNotificationToggle address="GADDRESS" />);
    await waitFor(() =>
      expect(screen.getByTestId('push-toggle')).toHaveTextContent(/Enable browser push/i),
    );
  });

  it('subscribes on click and flips to "Disable"', async () => {
    render(<PushNotificationToggle address="GADDRESS" />);
    await waitFor(() => expect(screen.getByTestId('push-toggle')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('push-toggle'));
    });

    expect(subscribeToPush).toHaveBeenCalledWith('GADDRESS');
    await waitFor(() =>
      expect(screen.getByTestId('push-toggle')).toHaveTextContent(/Disable browser push/i),
    );
  });

  it('shows an error when subscription fails', async () => {
    subscribeToPush.mockRejectedValueOnce(new Error('permission denied'));
    render(<PushNotificationToggle address="GADDRESS" />);
    await waitFor(() => expect(screen.getByTestId('push-toggle')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('push-toggle'));
    });

    expect(await screen.findByTestId('push-error')).toHaveTextContent(/permission denied/i);
  });

  it('renders a fallback when push is unsupported', async () => {
    vi.doMock('@/lib/notifications/push', async () => {
      const actual = await vi.importActual<typeof import('@/lib/notifications/push')>(
        '@/lib/notifications/push',
      );
      return { ...actual, isPushSupported: () => false };
    });
    vi.resetModules();
    const { PushNotificationToggle: Toggle } = await import(
      '@/components/notifications/PushNotificationToggle'
    );
    render(<Toggle address="GADDRESS" />);
    await waitFor(() =>
      expect(screen.queryByTestId('push-toggle')).not.toBeInTheDocument(),
    );
  });
});
