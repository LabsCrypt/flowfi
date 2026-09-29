import { prisma } from '../lib/prisma';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import webpush from 'web-push';

export type StreamEventType =
  | 'STREAM_CREATED'
  | 'CLIFF_REACHED'
  | 'RUNWAY_WARNING'
  | 'TOKENS_CLAIMED';

export interface StreamEvent {
  type: StreamEventType;
  address: string;
  title: string;
  body: string;
  url?: string;
  data?: Record<string, unknown>;
}

const TELEGRAM_API = 'https://api.telegram.org';

export class NotificationService {
  private vapidReady = false;

  constructor() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT ?? 'mailto:alerts@flowfi.app';
    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidReady = true;
    }
  }

  async subscribeWebPush(input: {
    address: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
  }) {
    return prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      update: {
        address: input.address,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent,
      },
      create: {
        address: input.address,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent,
      },
    });
  }

  async unsubscribeWebPush(address: string, endpoint: string) {
    return prisma.pushSubscription.deleteMany({ where: { address, endpoint } });
  }

  async generateLinkCode(address: string) {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    return prisma.linkCode.create({ data: { code, address, expiresAt } });
  }

  async linkTelegram(code: string, chatId: string) {
    const record = await prisma.linkCode.findUnique({ where: { code } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new Error('Link code is invalid or expired');
    }
    await prisma.linkCode.update({ where: { code }, data: { usedAt: new Date() } });
    return prisma.notificationChannel.upsert({
      where: { address: record.address },
      update: { telegramChatId: chatId },
      create: { address: record.address, telegramChatId: chatId },
    });
  }

  async setDiscordWebhook(address: string, webhookUrl: string) {
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(webhookUrl)) {
      throw new Error('Invalid Discord webhook URL');
    }
    return prisma.notificationChannel.upsert({
      where: { address },
      update: { discordWebhook: webhookUrl },
      create: { address, discordWebhook: webhookUrl },
    });
  }

  async dispatch(event: StreamEvent): Promise<void> {
    const [subs, channel] = await Promise.all([
      prisma.pushSubscription.findMany({ where: { address: event.address } }),
      prisma.notificationChannel.findUnique({ where: { address: event.address } }),
    ]);

    const tasks: Array<Promise<unknown>> = [];
    for (const sub of subs) tasks.push(this.sendWebPush(sub, event));
    if (channel?.telegramChatId) tasks.push(this.sendTelegram(channel.telegramChatId, event));
    if (channel?.discordWebhook) tasks.push(this.sendDiscord(channel.discordWebhook, event));

    await Promise.allSettled(tasks);
  }

  private async sendWebPush(
    sub: { endpoint: string; p256dh: string; auth: string },
    event: StreamEvent,
  ) {
    if (!this.vapidReady) return;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title: event.title,
          body: event.body,
          url: event.url ?? '/',
          event: event.type,
          tag: `flowfi-${event.type.toLowerCase()}`,
        }),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
      }
    }
  }

  private async sendTelegram(chatId: string, event: StreamEvent) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `*${event.title}*\n${event.body}`,
        parse_mode: 'Markdown',
      }),
    }).catch(() => undefined);
  }

  private async sendDiscord(webhookUrl: string, event: StreamEvent) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: event.title,
          description: event.body,
          color: event.type === 'RUNWAY_WARNING' ? 0xf59e0b : 0x6366f1,
          timestamp: new Date().toISOString(),
        }],
      }),
    }).catch(() => undefined);
  }
}

export const notificationService = new NotificationService();
