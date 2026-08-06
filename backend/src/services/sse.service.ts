import { randomUUID } from 'crypto';
import type { Response } from 'express';
import logger, { requestContext } from '../logger.js';
import { isRedisAvailable, getPublisher, getSubscriber } from '../lib/redis.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_WRITABLE_BUFFER = 64 * 1024;
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_CONNECTIONS_PER_USER = 10;
const RETRY_AFTER_SECONDS = 60;

interface SSEClient {
  id: string;
  res: Response;
  subscriptions: Set<string>;
  paused: boolean;
  ip: string;
  userId?: string;
}

interface SSECapacityCheckResult {
  allowed: boolean;
  status?: number;
  retryAfterSeconds?: number;
  message?: string;
}

export class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private slowClientsDropped = 0;
  private readonly ipConnectionCounts: Map<string, number> = new Map();
  private readonly userConnectionCounts: Map<string, number> = new Map();
  private shuttingDown = false;
  private perIpPeakConnections = 0;
  private perUserPeakConnections = 0;

  /**
   * Stable id attached to every log line emitted by the heartbeat
   * setInterval callback, since it fires outside of any HTTP request and
   * would otherwise have no requestContext (and thus no correlation id).
   */
  private readonly heartbeatWorkerId = `sse-heartbeat:${randomUUID()}`;

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

  checkCapacity(ip: string, userId?: string): SSECapacityCheckResult {
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

    // Independent of the per-IP cap: bounds how many concurrent SSE
    // subscriptions a single authenticated user can hold regardless of which
    // IP(s) they connect from (e.g. multiple tabs/devices behind different NATs).
    if (userId) {
      const currentUserConnections = this.userConnectionCounts.get(userId) ?? 0;
      if (currentUserConnections >= MAX_CONNECTIONS_PER_USER) {
        return {
          allowed: false,
          status: 429,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
          message: `Too many concurrent SSE connections for this user. Max ${MAX_CONNECTIONS_PER_USER}.`,
        };
      }
    }

    return { allowed: true };
  }

  addClient(
    clientId: string,
    res: Response,
    subscriptions: string[] = [],
    ip = 'unknown',
    userId?: string,
  ): void {
    const nextIpCount = (this.ipConnectionCounts.get(ip) ?? 0) + 1;
    this.ipConnectionCounts.set(ip, nextIpCount);
    this.perIpPeakConnections = Math.max(this.perIpPeakConnections, nextIpCount);

    if (userId) {
      const nextUserCount = (this.userConnectionCounts.get(userId) ?? 0) + 1;
      this.userConnectionCounts.set(userId, nextUserCount);
      this.perUserPeakConnections = Math.max(this.perUserPeakConnections, nextUserCount);
    }

    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
      paused: false,
      ip,
      ...(userId !== undefined && { userId }),
    };

    this.clients.set(clientId, client);
    logger.info(
      `[SSEService] Connection opened: ${clientId}, ip: ${ip}, userId: ${userId ?? 'n/a'}, subscriptions: ${subscriptions.join(', ')}`
    );

    res.on('close', () => {
      this.removeClient(clientId);
    });

    this.ensureHeartbeat();
  }

  sendHeartbeat(): void {
    const message = ': heartbeat\n\n';

    for (const client of this.clients.values()) {
      this.writeToClient(client, message);
    }
  }

  sendReconnectToAll(): void {
    this.shuttingDown = true;
    const message = 'event: reconnect\ndata: {}\n\n';
    for (const client of this.clients.values()) {
      try {
        client.res.write(message);
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
        this.writeToClient(client, message);
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

  getSlowClientsDropped(): number {
    return this.slowClientsDropped;
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

  getPerUserPeakConnections(): number {
    return this.perUserPeakConnections;
  }

  getActiveUserCount(): number {
    return this.userConnectionCounts.size;
  }

  getUserConnectionCount(userId: string): number {
    return this.userConnectionCounts.get(userId) ?? 0;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      requestContext.run({ requestId: this.heartbeatWorkerId }, () => {
        this.sendHeartbeat();
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private getWritableLength(res: Response): number {
    const response = res as Response & { writableLength?: number };
    if (typeof response.writableLength === 'number') {
      return response.writableLength;
    }

    return res.socket?.writableLength ?? 0;
  }

  private removeClient(clientId: string, reason?: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.clients.delete(clientId);

    const currentIpCount = this.ipConnectionCounts.get(client.ip) ?? 0;
    if (currentIpCount <= 1) {
      this.ipConnectionCounts.delete(client.ip);
    } else {
      this.ipConnectionCounts.set(client.ip, currentIpCount - 1);
    }

    if (client.userId) {
      const currentUserCount = this.userConnectionCounts.get(client.userId) ?? 0;
      if (currentUserCount <= 1) {
        this.userConnectionCounts.delete(client.userId);
      } else {
        this.userConnectionCounts.set(client.userId, currentUserCount - 1);
      }
    }

    try {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // Ignore errors while closing a broken connection.
    }

    if (reason) {
      logger.warn(`SSE client removed (${reason}): ${clientId}`);
    }
  }

  private dropSlowClient(client: SSEClient): void {
    this.slowClientsDropped += 1;
    this.removeClient(client.id, 'slow-client');
  }

  private writeToClient(client: SSEClient, message: string): boolean {
    if (client.paused) {
      if (this.getWritableLength(client.res) >= MAX_WRITABLE_BUFFER) {
        this.dropSlowClient(client);
      }
      return false;
    }

    try {
      const ok = client.res.write(message);

      if (!ok) {
        client.paused = true;
        client.res.once('drain', () => {
          client.paused = false;
        });

        if (this.getWritableLength(client.res) >= MAX_WRITABLE_BUFFER) {
          this.dropSlowClient(client);
        }
      }

      return ok;
    } catch {
      this.removeClient(client.id, 'write-failure');
      return false;
    }
  }
}

export const sseService = new SSEService();
export type { SSEClient };
