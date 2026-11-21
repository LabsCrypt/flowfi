import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface PushEventMock {
  data: {
    json: () => Record<string, unknown>;
    text: () => string;
  } | null;
  waitUntil: (p: Promise<unknown>) => void;
}

interface NotificationClickEventMock {
  notification: {
    close: () => void;
    data?: { url?: string } | null;
  };
  waitUntil: (p: Promise<unknown>) => void;
}

interface WindowClientMock {
  navigate?: (url: string) => Promise<unknown>;
  focus?: () => Promise<unknown>;
}

type EventHandler = (event: unknown) => void;

describe('Service Worker Push and Notification Click (sw.js)', () => {
  let listeners: Record<string, EventHandler[]>;
  let mockShowNotification: Mock<(...args: unknown[]) => Promise<void>>;
  let mockMatchAll: Mock<(options?: unknown) => Promise<WindowClientMock[]>>;
  let mockOpenWindow: Mock<(url: string) => Promise<WindowClientMock>>;
  let mockClientsClaim: Mock<() => Promise<void>>;
  let mockSkipWaiting: Mock<() => Promise<void>>;

  function loadSW() {
    listeners = {};
    mockShowNotification = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    mockMatchAll = vi.fn<(options?: unknown) => Promise<WindowClientMock[]>>().mockResolvedValue([]);
    mockOpenWindow = vi.fn<(url: string) => Promise<WindowClientMock>>().mockResolvedValue({ focus: vi.fn() });
    mockClientsClaim = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockSkipWaiting = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const mockCaches = {
      open: vi.fn().mockResolvedValue({
        addAll: vi.fn().mockResolvedValue(undefined),
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
      }),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      match: vi.fn().mockResolvedValue(undefined),
    };

    const selfMock = {
      addEventListener: (type: string, handler: EventHandler) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(handler);
      },
      registration: {
        showNotification: mockShowNotification,
      },
      clients: {
        claim: mockClientsClaim,
        matchAll: mockMatchAll,
        openWindow: mockOpenWindow,
      },
      caches: mockCaches,
      skipWaiting: mockSkipWaiting,
      location: {
        origin: 'https://flowfi.test',
        hostname: 'flowfi.test',
      },
    };

    const sandbox = {
      self: selfMock,
      caches: mockCaches,
      fetch: vi.fn(),
      Response: class MockResponse {
        static error() {
          return new MockResponse();
        }
      },
      URL,
      Promise,
      Date,
      console,
      setTimeout,
      clearTimeout,
    };

    const swPath = path.resolve(__dirname, '../../public/sw.js');
    const swCode = fs.readFileSync(swPath, 'utf-8');

    const context = vm.createContext(sandbox);
    vm.runInContext(swCode, context);
  }

  beforeEach(() => {
    loadSW();
  });

  describe('push event behavior', () => {
    it('handles valid JSON push payloads and configures notification options', async () => {
      const pushHandler = listeners['push']?.[0];
      expect(pushHandler).toBeDefined();

      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: PushEventMock = {
        data: {
          json: () => ({
            title: 'Incoming Stream',
            body: 'Stream #42 was created by Alice',
            url: '/streams/42',
            tag: 'stream-42',
            event: 'STREAM_CREATED',
          }),
          text: () => '{"title":"Incoming Stream"}',
        },
        waitUntil,
      };

      pushHandler!(event);
      expect(waitUntil).toHaveBeenCalled();
      await Promise.all(waitUntilPromises);

      expect(mockShowNotification).toHaveBeenCalledWith('Incoming Stream', {
        body: 'Stream #42 was created by Alice',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: 'stream-42',
        requireInteraction: false,
        data: { url: '/streams/42' },
      });
    });

    it('sets requireInteraction to true when event is RUNWAY_WARNING', async () => {
      const pushHandler = listeners['push']?.[0];
      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: PushEventMock = {
        data: {
          json: () => ({
            title: 'Runway Warning',
            body: 'Stream #99 will run out of funds in 1 hour',
            event: 'RUNWAY_WARNING',
            url: '/streams/99',
          }),
          text: () => '',
        },
        waitUntil,
      };

      pushHandler!(event);
      await Promise.all(waitUntilPromises);

      expect(mockShowNotification).toHaveBeenCalledWith('Runway Warning', {
        body: 'Stream #99 will run out of funds in 1 hour',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: 'flowfi-stream',
        requireInteraction: true,
        data: { url: '/streams/99' },
      });
    });

    it('handles malformed JSON / raw text payloads gracefully', async () => {
      const pushHandler = listeners['push']?.[0];
      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: PushEventMock = {
        data: {
          json: () => {
            throw new SyntaxError('Unexpected token in JSON');
          },
          text: () => 'Plain text push message from server',
        },
        waitUntil,
      };

      pushHandler!(event);
      await Promise.all(waitUntilPromises);

      expect(mockShowNotification).toHaveBeenCalledWith('FlowFi', {
        body: 'Plain text push message from server',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: 'flowfi-stream',
        requireInteraction: false,
        data: { url: '/' },
      });
    });

    it('handles missing push payloads (event.data is null or undefined)', async () => {
      const pushHandler = listeners['push']?.[0];
      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: PushEventMock = {
        data: null,
        waitUntil,
      };

      pushHandler!(event);
      await Promise.all(waitUntilPromises);

      expect(mockShowNotification).toHaveBeenCalledWith('FlowFi', {
        body: 'You have a new stream update.',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: 'flowfi-stream',
        requireInteraction: false,
        data: { url: '/' },
      });
    });
  });

  describe('notificationclick event behavior', () => {
    it('closes notification and focuses an existing window (window reuse)', async () => {
      const clickHandler = listeners['notificationclick']?.[0];
      expect(clickHandler).toBeDefined();

      const mockClose = vi.fn();
      const mockFocus = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
      const mockNavigate = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue(undefined);

      const existingClient: WindowClientMock = {
        navigate: mockNavigate,
        focus: mockFocus,
      };
      mockMatchAll.mockResolvedValue([existingClient]);

      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: NotificationClickEventMock = {
        notification: {
          close: mockClose,
          data: { url: '/streams/42' },
        },
        waitUntil,
      };

      clickHandler!(event);

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntilPromises);

      expect(mockMatchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
      expect(mockNavigate).toHaveBeenCalledWith('/streams/42');
      expect(mockFocus).toHaveBeenCalledTimes(1);
      expect(mockOpenWindow).not.toHaveBeenCalled();
    });

    it('opens a new window when no matching existing window client is found', async () => {
      const clickHandler = listeners['notificationclick']?.[0];
      const mockClose = vi.fn();
      mockMatchAll.mockResolvedValue([]);

      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: NotificationClickEventMock = {
        notification: {
          close: mockClose,
          data: { url: '/dashboard' },
        },
        waitUntil,
      };

      clickHandler!(event);

      expect(mockClose).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntilPromises);

      expect(mockMatchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
      expect(mockOpenWindow).toHaveBeenCalledWith('/dashboard');
    });

    it('falls back to default target "/" when notification data or url is missing', async () => {
      const clickHandler = listeners['notificationclick']?.[0];
      const mockClose = vi.fn();
      mockMatchAll.mockResolvedValue([]);

      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: NotificationClickEventMock = {
        notification: {
          close: mockClose,
          data: null,
        },
        waitUntil,
      };

      clickHandler!(event);
      await Promise.all(waitUntilPromises);

      expect(mockOpenWindow).toHaveBeenCalledWith('/');
    });

    it('skips non-focusable clients and opens window if none can be focused', async () => {
      const clickHandler = listeners['notificationclick']?.[0];
      const mockClose = vi.fn();
      mockMatchAll.mockResolvedValue([{}]);

      const waitUntilPromises: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      const event: NotificationClickEventMock = {
        notification: {
          close: mockClose,
          data: { url: '/streams/10' },
        },
        waitUntil,
      };

      clickHandler!(event);
      await Promise.all(waitUntilPromises);

      expect(mockOpenWindow).toHaveBeenCalledWith('/streams/10');
    });
  });
});
