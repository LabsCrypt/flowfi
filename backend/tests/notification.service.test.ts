import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { prismaMock, webpushMock } = vi.hoisted(() => ({
  prismaMock: {
    pushSubscription: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    notificationChannel: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    linkCode: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  webpushMock: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
}));

vi.mock('web-push', () => ({
  default: webpushMock,
}));

import {
  NotificationService,
  type StreamEvent,
} from '../src/services/notification.service.js';

describe('NotificationService', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };

  const sampleEvent: StreamEvent = {
    type: 'STREAM_CREATED',
    address: 'GUSER123',
    title: 'Stream Created',
    body: 'A new stream of 100 XLM was created.',
    url: '/streams/1',
  };

  const samplePushSub = {
    endpoint: 'https://push.example.com/endpoint/1',
    p256dh: 'test-p256dh-key',
    auth: 'test-auth-key',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      VAPID_PUBLIC_KEY: 'test-vapid-public-key',
      VAPID_PRIVATE_KEY: 'test-vapid-private-key',
      VAPID_SUBJECT: 'mailto:test@flowfi.app',
      TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    };
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    webpushMock.sendNotification.mockResolvedValue({ statusCode: 201 });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('dispatch - failure isolation', () => {
    it('attempts Telegram and Discord even when WebPush delivery fails', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue({
        address: 'GUSER123',
        telegramChatId: '12345678',
        discordWebhook: 'https://discord.com/api/webhooks/123/abc',
      });

      // Push rejects
      webpushMock.sendNotification.mockRejectedValue(new Error('Push service unavailable'));

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(webpushMock.sendNotification).toHaveBeenCalledTimes(1);

      // Verify Telegram was still attempted
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-telegram-token/sendMessage',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Stream Created'),
        }),
      );

      // Verify Discord was still attempted
      expect(fetchMock).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Stream Created'),
        }),
      );
    });

    it('attempts Push and Discord even when Telegram delivery fails', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue({
        address: 'GUSER123',
        telegramChatId: '12345678',
        discordWebhook: 'https://discord.com/api/webhooks/123/abc',
      });

      // Telegram fetch rejects
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('telegram')) {
          throw new Error('Telegram network error');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(webpushMock.sendNotification).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.anything(),
      );
    });

    it('attempts Push and Telegram even when Discord delivery fails', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue({
        address: 'GUSER123',
        telegramChatId: '12345678',
        discordWebhook: 'https://discord.com/api/webhooks/123/abc',
      });

      // Discord fetch rejects
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('discord')) {
          throw new Error('Discord rate limit / error');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(webpushMock.sendNotification).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-telegram-token/sendMessage',
        expect.anything(),
      );
    });

    it('delivers to remaining push subscriptions when one subscription fails', async () => {
      const sub1 = { ...samplePushSub, endpoint: 'https://push.example.com/sub1' };
      const sub2 = { ...samplePushSub, endpoint: 'https://push.example.com/sub2' };

      prismaMock.pushSubscription.findMany.mockResolvedValue([sub1, sub2]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue(null);

      webpushMock.sendNotification
        .mockRejectedValueOnce(new Error('Sub 1 network failure'))
        .mockResolvedValueOnce({ statusCode: 201 });

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(webpushMock.sendNotification).toHaveBeenCalledTimes(2);
      expect(webpushMock.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: sub1.endpoint }),
        expect.any(String),
      );
      expect(webpushMock.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: sub2.endpoint }),
        expect.any(String),
      );
    });
  });

  describe('dispatch - expired subscriptions (404 and 410) and transient failures', () => {
    it('deletes expired push subscription when service returns HTTP 404', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue(null);
      prismaMock.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });

      const error404 = new Error('Not Found');
      (error404 as unknown as { statusCode: number }).statusCode = 404;
      webpushMock.sendNotification.mockRejectedValue(error404);

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(prismaMock.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: samplePushSub.endpoint },
      });
    });

    it('deletes expired push subscription when service returns HTTP 410 (Gone)', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue(null);
      prismaMock.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });

      const error410 = new Error('Gone');
      (error410 as unknown as { statusCode: number }).statusCode = 410;
      webpushMock.sendNotification.mockRejectedValue(error410);

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(prismaMock.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: samplePushSub.endpoint },
      });
    });

    it('retains push subscription on transient failures (e.g. 500, 503, ETIMEDOUT)', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue(null);

      const error500 = new Error('Internal Server Error');
      (error500 as unknown as { statusCode: number }).statusCode = 500;
      webpushMock.sendNotification.mockRejectedValue(error500);

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(prismaMock.pushSubscription.deleteMany).not.toHaveBeenCalled();
    });

    it('retains push subscription on network errors without statusCode', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue(null);

      webpushMock.sendNotification.mockRejectedValue(new Error('Connection reset by peer'));

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      expect(prismaMock.pushSubscription.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('VAPID configuration handling', () => {
    it('configures webpush when VAPID keys are present', () => {
      new NotificationService();

      expect(webpushMock.setVapidDetails).toHaveBeenCalledWith(
        'mailto:test@flowfi.app',
        'test-vapid-public-key',
        'test-vapid-private-key',
      );
    });

    it('prevents push delivery when VAPID configuration is absent', async () => {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      prismaMock.pushSubscription.findMany.mockResolvedValue([samplePushSub]);
      prismaMock.notificationChannel.findUnique.mockResolvedValue({
        address: 'GUSER123',
        telegramChatId: '12345678',
      });

      const service = new NotificationService();
      await service.dispatch(sampleEvent);

      // Push delivery skipped due to absent VAPID configuration
      expect(webpushMock.sendNotification).not.toHaveBeenCalled();

      // Telegram delivery should still proceed
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-telegram-token/sendMessage',
        expect.anything(),
      );
    });
  });

  describe('subscription and link management helpers', () => {
    it('subscribes web push endpoint via upsert', async () => {
      prismaMock.pushSubscription.upsert.mockResolvedValue({ id: 'sub-1' });

      const service = new NotificationService();
      await service.subscribeWebPush({
        address: 'GUSER123',
        endpoint: 'https://push.example.com/endpoint',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        userAgent: 'Mozilla/5.0',
      });

      expect(prismaMock.pushSubscription.upsert).toHaveBeenCalledWith({
        where: { endpoint: 'https://push.example.com/endpoint' },
        update: {
          address: 'GUSER123',
          p256dh: 'p256dh-key',
          auth: 'auth-key',
          userAgent: 'Mozilla/5.0',
        },
        create: {
          address: 'GUSER123',
          endpoint: 'https://push.example.com/endpoint',
          p256dh: 'p256dh-key',
          auth: 'auth-key',
          userAgent: 'Mozilla/5.0',
        },
      });
    });

    it('unsubscribes web push endpoint', async () => {
      prismaMock.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });

      const service = new NotificationService();
      await service.unsubscribeWebPush('GUSER123', 'https://push.example.com/endpoint');

      expect(prismaMock.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { address: 'GUSER123', endpoint: 'https://push.example.com/endpoint' },
      });
    });

    it('generates a valid link code', async () => {
      prismaMock.linkCode.create.mockImplementation(async ({ data }) => ({
        id: 'lc-1',
        ...data,
      }));

      const service = new NotificationService();
      const result = await service.generateLinkCode('GUSER123');

      expect(result).toHaveProperty('code');
      expect(result.address).toBe('GUSER123');
      expect(prismaMock.linkCode.create).toHaveBeenCalledTimes(1);
    });

    it('links telegram when code is valid', async () => {
      prismaMock.linkCode.findUnique.mockResolvedValue({
        code: 'VALID1',
        address: 'GUSER123',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prismaMock.linkCode.update.mockResolvedValue({});
      prismaMock.notificationChannel.upsert.mockResolvedValue({});

      const service = new NotificationService();
      await service.linkTelegram('VALID1', 'chat_999');

      expect(prismaMock.linkCode.update).toHaveBeenCalledWith({
        where: { code: 'VALID1' },
        data: { usedAt: expect.any(Date) },
      });
      expect(prismaMock.notificationChannel.upsert).toHaveBeenCalledWith({
        where: { address: 'GUSER123' },
        update: { telegramChatId: 'chat_999' },
        create: { address: 'GUSER123', telegramChatId: 'chat_999' },
      });
    });

    it('rejects linking telegram when code is invalid or expired', async () => {
      prismaMock.linkCode.findUnique.mockResolvedValue({
        code: 'EXPIRED',
        address: 'GUSER123',
        usedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const service = new NotificationService();
      await expect(service.linkTelegram('EXPIRED', 'chat_999')).rejects.toThrow(
        'Link code is invalid or expired',
      );
    });

    it('sets discord webhook for valid url', async () => {
      prismaMock.notificationChannel.upsert.mockResolvedValue({});

      const service = new NotificationService();
      await service.setDiscordWebhook(
        'GUSER123',
        'https://discord.com/api/webhooks/12345/abcdef',
      );

      expect(prismaMock.notificationChannel.upsert).toHaveBeenCalledWith({
        where: { address: 'GUSER123' },
        update: { discordWebhook: 'https://discord.com/api/webhooks/12345/abcdef' },
        create: { address: 'GUSER123', discordWebhook: 'https://discord.com/api/webhooks/12345/abcdef' },
      });
    });

    it('rejects invalid discord webhook url', async () => {
      const service = new NotificationService();
      await expect(
        service.setDiscordWebhook('GUSER123', 'https://malicious.example.com/webhook'),
      ).rejects.toThrow('Invalid Discord webhook URL');
    });
  });
});
