import { prisma } from '../lib/prisma.js';
import { notificationService } from '../services/notification.service.js';

const POLL_INTERVAL_MS = 60_000;
const RUNWAY_WARNING_HOURS = 24;

export class NotificationBotWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly warned = new Set<string>();

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollRunwayWarnings().catch(() => undefined);
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async notify(type: string, address: string, data: Record<string, any>): Promise<void> {
    const map: Record<string, { title: string; body: string; url: string }> = {
      STREAM_CREATED: {
        title: '🌊 New stream received',
        body: `You are receiving a new stream of ${data.amount ?? ''} ${data.symbol ?? ''} from ${shorten(data.sender)}`,
        url: `/streams/${data.streamId ?? ''}`,
      },
      CLIFF_REACHED: {
        title: '🎯 Vesting cliff reached',
        body: `${data.amount ?? ''} ${data.symbol ?? ''} tokens are now claimable.`,
        url: `/streams/${data.streamId ?? ''}`,
      },
      RUNWAY_WARNING: {
        title: '⚠️ Low runway warning',
        body: `Stream #${data.streamId ?? ''} has less than ${RUNWAY_WARNING_HOURS} hours of runway remaining. Refuel now.`,
        url: `/streams/${data.streamId ?? ''}`,
      },
      TOKENS_CLAIMED: {
        title: '✅ Withdrawal confirmed',
        body: `Successfully withdrawn ${data.amount ?? ''} ${data.symbol ?? ''} to your wallet.`,
        url: `/streams/${data.streamId ?? ''}`,
      },
    };
    const build = map[type];
    if (!build) return;
    await notificationService.dispatch({ type: type as any, address, ...build, data });
  }

  private async pollRunwayWarnings(): Promise<void> {
    const now = Date.now();
    const horizon = now + RUNWAY_WARNING_HOURS * 60 * 60 * 1000;

    const streams = await prisma.stream.findMany({
      where: {
        isActive: true,
        isPaused: false,
        endTime: {
          gt: BigInt(Math.floor(now / 1000)),
          lt: BigInt(Math.floor(horizon / 1000)),
        },
      },
      take: 200,
    });

    for (const stream of streams) {
      const key = `${stream.streamId}:${stream.sender}:RUNWAY_WARNING`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      await notificationService.dispatch({
        type: 'RUNWAY_WARNING',
        address: stream.sender,
        title: '⚠️ Stream runway below 24 hours',
        body: `Stream #${stream.streamId} is running low. Refuel to avoid a payroll halt.`,
        url: `/streams/${stream.streamId}`,
      });
    }
  }
}

function shorten(address?: string): string {
  if (!address) return 'unknown';
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export const notificationBotWorker = new NotificationBotWorker();
