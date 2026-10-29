import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { subscribeToPush, unsubscribeFromPush, getExistingSubscription } = vi.hoisted(() => ({
  subscribeToPush: vi.fn(async () => ({}) as PushSubscription),
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
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual(Array.from(urlBase64ToUint8Array('+/8=')));
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

describe('public/sw.js service worker', () => {
  type Listener = (event: unknown) => void;
  type PushEventLike = {
    data?: { json?: () => unknown; text?: () => string } | null;
    waitUntil: ReturnType<typeof vi.fn>;
    settle: () => Promise<unknown>;
  };
  type NotificationClickEventLike = {
    notification: { close: ReturnType<typeof vi.fn>; data: { url: string } };
    waitUntil: ReturnType<typeof vi.fn>;
    settle: () => Promise<unknown>;
  };
  type ClientLike = {
    url?: string;
    focus: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
  };

  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

  let listeners: Record<string, Listener>;
  let self: {
    addEventListener: (type: string, fn: Listener) => void;
    registration: { showNotification: ReturnType<typeof vi.fn> };
    skipWaiting: ReturnType<typeof vi.fn>;
    clients: unknown;
  };
  let clients: { matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> };
  let showNotification: ReturnType<typeof vi.fn>;

  // Runs the actual service-worker script inside a function scope whose
  // `self`, `clients`, and `registration` globals are controlled by the test.
  function loadWorker() {
    listeners = {};
    showNotification = vi.fn(async () => undefined);
    clients = {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => undefined),
    };
    self = {
      addEventListener: (type: string, fn: Listener) => {
        listeners[type] = fn;
      },
      registration: { showNotification },
      skipWaiting: vi.fn(),
      clients,
    };
    new Function('self', 'clients', 'registration', source)(
      self,
      clients,
      self.registration,
    );
  }

  function makeEvent<T extends Record<string, unknown>>(init: T) {
    const pending: Promise<unknown>[] = [];
    return {
      ...init,
      waitUntil: vi.fn((p: Promise<unknown>) => {
        pending.push(p);
      }),
      settle: () => Promise.all(pending),
    };
  }

  beforeEach(() => {
    loadWorker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('push event', () => {
    it('registers a push listener', () => {
      expect(listeners.push).toBeTypeOf('function');
    });

    it('shows a notification from valid JSON payload', async () => {
      const event: PushEventLike = makeEvent({
        data: {
          json: () => ({ title: 'Stream paid', body: 'You received 5 XLM' }),
          text: () => '',
        },
      });
      listeners.push(event);
      expect(event.waitUntil).toHaveBeenCalledTimes(1);
      await event.settle();
      expect(showNotification).toHaveBeenCalledTimes(1);
      const [title, options] = showNotification.mock.calls[0];
      expect(title).toBe('Stream paid');
      expect(options.body).toBe('You received 5 XLM');
    });

    it('falls back to text when payload is not valid JSON', async () => {
      const event: PushEventLike = makeEvent({
        data: {
          json: () => {
            throw new SyntaxError('bad json');
          },
          text: () => 'plain text ping',
        },
      });
      listeners.push(event);
      await event.settle();
      expect(showNotification).toHaveBeenCalledTimes(1);
      const [, options] = showNotification.mock.calls[0];
      expect(options.body).toBe('plain text ping');
    });

    it('shows a default notification when push has no payload', async () => {
      const event: PushEventLike = makeEvent({ data: null });
      listeners.push(event);
      expect(event.waitUntil).toHaveBeenCalledTimes(1);
      await event.settle();
      expect(showNotification).toHaveBeenCalledTimes(1);
    });

    it('handles a push event whose data has no json or text methods', async () => {
      const event: PushEventLike = makeEvent({ data: {} });
      listeners.push(event);
      expect(event.waitUntil).toHaveBeenCalledTimes(1);
      await event.settle();
      expect(showNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('notificationclick event', () => {
    it('focuses and navigates an existing window instead of opening a new one', async () => {
      const existing: ClientLike = {
        url: 'https://app.test/dashboard',
        focus: vi.fn(async () => existing),
        navigate: vi.fn(async () => existing),
      };
      clients.matchAll.mockResolvedValueOnce([existing]);
      const event: NotificationClickEventLike = makeEvent({
        notification: { close: vi.fn(), data: { url: '/streams/1' } },
      });
      listeners.notificationclick(event);
      expect(event.notification.close).toHaveBeenCalled();
      expect(event.waitUntil).toHaveBeenCalledTimes(1);
      await event.settle();
      expect(existing.focus).toHaveBeenCalled();
      expect(existing.navigate).toHaveBeenCalledWith('/streams/1');
      expect(clients.openWindow).not.toHaveBeenCalled();
    });

    it('opens a new window when no client window exists', async () => {
      clients.matchAll.mockResolvedValueOnce([]);
      const event: NotificationClickEventLike = makeEvent({
        notification: { close: vi.fn(), data: { url: '/streams/2' } },
      });
      listeners.notificationclick(event);
      expect(event.notification.close).toHaveBeenCalled();
      expect(event.waitUntil).toHaveBeenCalledTimes(1);
      await event.settle();
      expect(clients.openWindow).toHaveBeenCalledWith('/streams/2');
    });

    it('closes the notification and waits on the click handling promise', async () => {
      clients.matchAll.mockResolvedValueOnce([]);
      const event: NotificationClickEventLike = makeEvent({
        notification: { close: vi.fn(), data: { url: '/streams/3' } },
      });
      listeners.notificationclick(event);
      expect(event.notification.close).toHaveBeenCalledTimes(1);
      expect(event.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
      await event.settle();
    });
  });
});
