import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Load the real service-worker script and execute it in a sandboxed scope
// with minimal fake service-worker globals, so the actual handlers run.

type Listener = (event: any) => void;

const swSource = fs.readFileSync(
  path.resolve(__dirname, '../../public/sw.js'),
  'utf8',
);

function createHarness() {
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  let clientList: any[] = [];

  const self: any = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clientList),
      openWindow,
    },
    registration: { showNotification },
  };

  // Execute the real script with `self` bound to our fake worker global.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', swSource)(self);

  return {
    listeners,
    showNotification,
    openWindow,
    setClients: (list: any[]) => {
      clientList = list;
    },
    self,
  };
}

function makeWaitable() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
  };
}

describe('public/sw.js push handler', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses valid JSON payloads and shows a notification with merged fields', async () => {
    const w = makeWaitable();
    const event = {
      data: {
        json: () => ({
          title: 'Stream ending',
          body: 'Runway low',
          url: '/streams/1',
          tag: 'stream-1',
          event: 'RUNWAY_WARNING',
        }),
        text: () => '',
      },
      waitUntil: w.waitUntil,
    };

    harness.listeners.push(event);
    expect(w.promises).toHaveLength(1);
    await Promise.all(w.promises);

    expect(harness.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = harness.showNotification.mock.calls[0] as any[];
    expect(title).toBe('Stream ending');
    expect(options).toMatchObject({
      body: 'Runway low',
      tag: 'stream-1',
      requireInteraction: true,
      data: { url: '/streams/1' },
      icon: '/icon-192.png',
      badge: '/badge-72.png',
    });
  });

  it('falls back to text body when payload is not valid JSON', async () => {
    const w = makeWaitable();
    const event = {
      data: {
        json: () => {
          throw new SyntaxError('Unexpected token');
        },
        text: () => 'plain message',
      },
      waitUntil: w.waitUntil,
    };

    harness.listeners.push(event);
    await Promise.all(w.promises);

    const [title, options] = harness.showNotification.mock.calls[0] as any[];
    expect(title).toBe('FlowFi');
    expect(options.body).toBe('plain message');
    expect(options.tag).toBe('flowfi-stream');
    expect(options.requireInteraction).toBe(false);
    expect(options.data).toEqual({ url: '/' });
  });

  it('uses default notification when push has no data', async () => {
    const w = makeWaitable();
    const event = { data: null, waitUntil: w.waitUntil };

    harness.listeners.push(event);
    await Promise.all(w.promises);

    const [title, options] = harness.showNotification.mock.calls[0] as any[];
    expect(title).toBe('FlowFi');
    expect(options.body).toBe('You have a new stream update.');
    expect(options.data).toEqual({ url: '/' });
    expect(w.promises).toHaveLength(1);
  });
});

describe('public/sw.js notificationclick handler', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function clickEvent(url?: string) {
    const w = makeWaitable();
    const close = vi.fn();
    const event = {
      notification: { close, data: url === undefined ? undefined : { url } },
      waitUntil: w.waitUntil,
    };
    return { event, close, w };
  }

  it('closes the notification, navigates and focuses an existing window', async () => {
    const client = {
      focus: vi.fn(async () => client),
      navigate: vi.fn(async () => client),
    };
    harness.setClients([client]);

    const { event, close, w } = clickEvent('/streams/9');
    harness.listeners.notificationclick(event);

    expect(close).toHaveBeenCalledTimes(1);
    expect(w.promises).toHaveLength(1);
    await Promise.all(w.promises);

    expect(client.navigate).toHaveBeenCalledWith('/streams/9');
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(harness.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window when no client window exists', async () => {
    harness.setClients([]);

    const { event, close, w } = clickEvent('/streams/3');
    harness.listeners.notificationclick(event);

    expect(close).toHaveBeenCalledTimes(1);
    expect(w.promises).toHaveLength(1);
    await Promise.all(w.promises);

    expect(harness.openWindow).toHaveBeenCalledWith('/streams/3');
  });

  it('defaults to "/" when notification data has no url', async () => {
    harness.setClients([]);

    const { event, w } = clickEvent(undefined);
    harness.listeners.notificationclick(event);
    await Promise.all(w.promises);

    expect(harness.openWindow).toHaveBeenCalledWith('/');
  });
});
