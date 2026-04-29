import type { Response } from 'express';
import logger from '../logger.js';
import { isRedisAvailable, getPublisher, getSubscriber } from '../lib/redis.js';

interface SSEClient {
  id: string;
  res: Response;
  subscriptions: Set<string>;
  ip: string;
  lastActivityAt: number;
}

const MAX_CONNECTIONS_PER_IP = 5;
const RETRY_AFTER_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
const IDLE_TIMEOUT_MS = 300000; // 5 minutes

interface SSECapacityCheckResult {
  allowed: boolean;
  status?: number;
  retryAfterSeconds?: number;
  message?: string;
}

export class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private readonly ipConnectionCounts: Map<string, number> = new Map();
  private shuttingDown = false;
  private perIpPeakConnections = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  private readonly maxConnections: number = (() => {
    const parsed = Number.parseInt(process.env.MAX_SSE_CONNECTIONS ?? '10000', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 10000;
    return parsed;
  })();

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async initRedisSubscription(): Promise<void> {
    const sub = getSubscriber();
    if (!sub) return;

    await sub.psubscribe('sse:stream:*', 'sse:user:*');
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      try {
        const { event, data } = JSON.parse(message) as { event: string; data: unknown };
        if (channel.startsWith('sse:stream:')) {
          this._localBroadcastToStream(channel.slice('sse:stream:'.length), event, data);
        } else if (channel.startsWith('sse:user:')) {
          this._localBroadcastToUser(channel.slice('sse:user:'.length), event, data);
        }
      } catch (err) {
        logger.warn('[Redis SSE] Failed to handle pub/sub message:', err);
      }
    });

    logger.info('[SSEService] Redis pub/sub subscription active.');
  }

  startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
      this.removeIdleConnections();
    }, HEARTBEAT_INTERVAL_MS);

    logger.info('[SSEService] Heartbeat started');
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('[SSEService] Heartbeat stopped');
    }
  }

  private sendHeartbeat(): void {
    const heartbeatMessage = ': keep-alive\n\n';
    let sentCount = 0;

    for (const client of this.clients.values()) {
      try {
        client.res.write(heartbeatMessage);
        sentCount++;
      } catch (err) {
        logger.warn(`[SSEService] Failed to send heartbeat to client ${client.id}:`, err);
        // Remove client on write failure
        this.removeClient(client.id);
      }
    }

    if (sentCount > 0) {
      logger.debug(`[SSEService] Sent heartbeat to ${sentCount} clients`);
    }
  }

  private removeIdleConnections(): void {
    const now = Date.now();
    const idleClients: string[] = [];

    for (const [clientId, client] of this.clients.entries()) {
      if (now - client.lastActivityAt > IDLE_TIMEOUT_MS) {
        idleClients.push(clientId);
      }
    }

    if (idleClients.length > 0) {
      logger.info(`[SSEService] Removing ${idleClients.length} idle connections`);
      for (const clientId of idleClients) {
        try {
          const client = this.clients.get(clientId);
          if (client) {
            client.res.end();
          }
        } catch (err) {
          logger.warn(`[SSEService] Error closing idle client ${clientId}:`, err);
        }
        this.removeClient(clientId);
      }
    }
  }

  checkCapacity(ip: string): SSECapacityCheckResult {
    if (this.clients.size >= this.maxConnections) {
      return {
        allowed: false,
        status: 503,
        message: 'SSE capacity reached. Please try again shortly.',
      };
    }

    const currentIpConnections = this.ipConnectionCounts.get(ip) ?? 0;
    if (currentIpConnections >= MAX_CONNECTIONS_PER_IP) {
      return {
        allowed: false,
        status: 429,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
        message: `Too many SSE connections from this IP. Max ${MAX_CONNECTIONS_PER_IP}.`,
      };
    }

    return { allowed: true };
  }

  addClient(clientId: string, res: Response, subscriptions: string[] = [], ip = 'unknown'): void {
    const nextIpCount = (this.ipConnectionCounts.get(ip) ?? 0) + 1;
    this.ipConnectionCounts.set(ip, nextIpCount);
    this.perIpPeakConnections = Math.max(this.perIpPeakConnections, nextIpCount);

    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
      ip,
      lastActivityAt: Date.now(),
    };

    this.clients.set(clientId, client);
    logger.info(
      `[SSEService] Connection opened: ${clientId}, ip: ${ip}, subscriptions: ${subscriptions.join(', ')}`
    );

    res.on('close', () => {
      this.removeClient(clientId);
    });
  }

  private removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);

    const currentIpCount = this.ipConnectionCounts.get(client.ip) ?? 0;
    if (currentIpCount <= 1) {
      this.ipConnectionCounts.delete(client.ip);
    } else {
      this.ipConnectionCounts.set(client.ip, currentIpCount - 1);
    }

    logger.info(`[SSEService] Connection closed: ${clientId}, ip: ${client.ip}`);
  }

  sendReconnectToAll(): void {
    this.shuttingDown = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    const message = 'event: reconnect\ndata: {}\n\n';
    for (const client of this.clients.values()) {
      try {
        client.res.write(message);
        client.lastActivityAt = Date.now();
      } catch {
        // ignore write errors during shutdown
      }
    }
    logger.info(`[SSEService] Sent reconnect to ${this.clients.size} client(s).`);
  }

  broadcast(event: string, data: unknown, filter?: (client: SSEClient) => boolean): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.values()) {
      if (!filter || filter(client)) {
        try {
          client.res.write(message);
          client.lastActivityAt = Date.now();
        } catch (err) {
          // ignore write errors
        }
      }
    }
  }

  broadcastToStream(streamId: string, event: string, data: unknown): void {
    if (isRedisAvailable()) {
      getPublisher()?.publish(`sse:stream:${streamId}`, JSON.stringify({ event, data }));
    } else {
      this._localBroadcastToStream(streamId, event, data);
    }
  }

  broadcastToUser(publicKey: string, event: string, data: unknown): void {
    if (isRedisAvailable()) {
      getPublisher()?.publish(`sse:user:${publicKey}`, JSON.stringify({ event, data }));
    } else {
      this._localBroadcastToUser(publicKey, event, data);
    }
  }

  broadcastToAdmin(event: string, data: unknown): void {
    const adminKey = process.env.ADMIN_PUBLIC_KEY;
    if (adminKey) {
      this.broadcastToUser(adminKey, event, data);
    }
  }

  private _localBroadcastToStream(streamId: string, event: string, data: unknown): void {
    this.broadcast(event, data, (client) =>
      client.subscriptions.has(streamId) || client.subscriptions.has('*')
    );
  }

  private _localBroadcastToUser(publicKey: string, event: string, data: unknown): void {
    this.broadcast(event, data, (client) =>
      client.subscriptions.has(`user:${publicKey}`) || client.subscriptions.has('*')
    );
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getMaxConnections(): number {
    return this.maxConnections;
  }

  getPerIpPeakConnections(): number {
    return this.perIpPeakConnections;
  }

  getActiveIpCount(): number {
    return this.ipConnectionCounts.size;
  }
}

export const sseService = new SSEService();
