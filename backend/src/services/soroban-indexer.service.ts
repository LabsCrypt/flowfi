import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';

type JsonRecord = Record<string, unknown>;

interface RpcEvent {
  id?: string;
  ledger?: number;
  ledgerSequence?: number;
  txHash?: string;
  topic?: unknown[];
  value?: unknown;
  contractId?: string;
}

interface RpcResponse {
  result?: {
    events?: RpcEvent[];
  };
  error?: {
    message?: string;
  };
}

type IndexedEventType = 'CREATED' | 'CANCELLED' | 'WITHDRAWN';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const POLL_MS = Number(process.env.SOROBAN_INDEXER_POLL_MS ?? 15000);
const START_LEDGER = Number(process.env.SOROBAN_INDEXER_START_LEDGER ?? 0);
const STREAM_CONTRACT_ID = process.env.STREAM_CONTRACT_ID ?? '';

export class SorobanIndexerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastLedger = START_LEDGER;

  start() {
    if (this.running) return;
    this.running = true;

    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_MS);

    logger.info(`Soroban indexer started (poll=${POLL_MS}ms, startLedger=${this.lastLedger})`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async poll() {
    if (!STREAM_CONTRACT_ID) return;

    try {
      const events = await this.fetchEvents(this.lastLedger + 1);
      if (events.length === 0) return;

      let maxLedger = this.lastLedger;
      for (const event of events) {
        const ledger = Number(event.ledgerSequence ?? event.ledger ?? 0);
        if (ledger > maxLedger) maxLedger = ledger;
        await this.indexEvent(event, ledger);
      }

      this.lastLedger = maxLedger;
    } catch (error) {
      logger.error('Soroban indexer poll failed', error);
    }
  }

  private async fetchEvents(startLedger: number): Promise<RpcEvent[]> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getEvents',
      params: {
        startLedger,
        filters: [{ type: 'contract', contractIds: [STREAM_CONTRACT_ID] }],
        pagination: { limit: 100 },
      },
    };

    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`getEvents failed: ${response.status}`);
    }

    const payload = (await response.json()) as RpcResponse;
    if (payload.error?.message) throw new Error(payload.error.message);
    return payload.result?.events ?? [];
  }

  private asRecord(value: unknown): JsonRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as JsonRecord;
  }

  private parseEventType(event: RpcEvent): IndexedEventType | null {
    const firstTopic = Array.isArray(event.topic) && event.topic.length > 0
      ? String(event.topic[0]).toLowerCase()
      : '';

    if (firstTopic.includes('stream_created')) return 'CREATED';
    if (firstTopic.includes('stream_cancelled')) return 'CANCELLED';
    if (firstTopic.includes('tokens_withdrawn')) return 'WITHDRAWN';
    return null;
  }

  private parseStreamId(record: JsonRecord): number | null {
    const raw = record.stream_id ?? record.streamId;
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isInteger(parsed)) return parsed;
    }
    return null;
  }

  private readString(record: JsonRecord, ...keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  }

  private async ensureUser(publicKey: string) {
    await prisma.user.upsert({
      where: { publicKey },
      update: {},
      create: { publicKey },
    });
  }

  private async indexEvent(event: RpcEvent, ledgerSequence: number) {
    const eventType = this.parseEventType(event);
    if (!eventType) return;

    const value = this.asRecord(event.value);
    if (!value) return;

    const streamId = this.parseStreamId(value);
    if (!streamId) return;

    const txHash = event.txHash ?? event.id ?? `event-${streamId}-${ledgerSequence}-${eventType}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const existing = await prisma.streamEvent.findFirst({
      where: {
        streamId,
        eventType,
        transactionHash: txHash,
        ledgerSequence,
      },
      select: { id: true },
    });
    if (existing) return;

    if (eventType === 'CREATED') {
      const sender = this.readString(value, 'sender');
      const recipient = this.readString(value, 'recipient');
      const tokenAddress = this.readString(value, 'token_address', 'tokenAddress');
      const ratePerSecond = this.readString(value, 'rate_per_second', 'ratePerSecond');
      const depositedAmount = this.readString(value, 'deposited_amount', 'depositedAmount');
      const startTimeRaw = value.start_time ?? value.startTime ?? timestamp;
      const startTime = Number(startTimeRaw);

      if (!sender || !recipient || !tokenAddress || !ratePerSecond || !depositedAmount) return;

      await this.ensureUser(sender);
      await this.ensureUser(recipient);

      await prisma.stream.upsert({
        where: { streamId },
        update: {
          sender,
          recipient,
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          lastUpdateTime: Number.isFinite(startTime) ? startTime : timestamp,
          isActive: true,
        },
        create: {
          streamId,
          sender,
          recipient,
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          withdrawnAmount: '0',
          startTime: Number.isFinite(startTime) ? startTime : timestamp,
          lastUpdateTime: Number.isFinite(startTime) ? startTime : timestamp,
          isActive: true,
        },
      });
    } else if (eventType === 'CANCELLED') {
      await prisma.stream.updateMany({
        where: { streamId },
        data: { isActive: false, lastUpdateTime: timestamp },
      });
    } else if (eventType === 'WITHDRAWN') {
      const stream = await prisma.stream.findUnique({ where: { streamId } });
      if (stream) {
        const amount = this.readString(value, 'amount') ?? '0';
        const nextWithdrawn = (BigInt(stream.withdrawnAmount) + BigInt(amount)).toString();
        await prisma.stream.update({
          where: { streamId },
          data: {
            withdrawnAmount: nextWithdrawn,
            lastUpdateTime: timestamp,
            isActive: BigInt(nextWithdrawn) < BigInt(stream.depositedAmount),
          },
        });
      }
    }

    await prisma.streamEvent.create({
      data: {
        streamId,
        eventType,
        amount: this.readString(value, 'amount'),
        transactionHash: txHash,
        ledgerSequence,
        timestamp,
        metadata: JSON.stringify({ topic: event.topic, value: event.value }),
      },
    });
  }
}

export const sorobanIndexerService = new SorobanIndexerService();
