import type { Response } from 'express';
import logger from '../logger.js';
import { isRedisAvailable, getSubscriber } from '../lib/redis.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_WRITABLE_BUFFER = 64 * 1024;

interface SSEClient {
  id: string;
  res: Response;
  subscriptions: Set<string>;
  paused: boolean;
}

export class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private slowClientsDropped = 0;
  private shuttingDown: boolean = false;
  private ipConnectionCounts: Map<string, number> = new Map();
  private ipPeakConnections: Map<string, number> = new Map();
  private maxConnectionsPerIp: number = 100;
  private globalMaxConnections: number = 10000;

  addClient(clientId: string, res: Response, subscriptions: string[] = [], ip = 'unknown'): void {
    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
      paused: false,
    };

    this.clients.set(clientId, client);

    // Track per-IP connection counts
    const ipCount = (this.ipConnectionCounts.get(ip) || 0) + 1;
    this.ipConnectionCounts.set(ip, ipCount);
    const peak = this.ipPeakConnections.get(ip) || 0;
    if (ipCount > peak) {
      this.ipPeakConnections.set(ip, ipCount);
    }

    logger.info(
      `[SSEService] Connection opened: ${clientId}, ip: ${ip}, subscriptions: ${subscriptions.join(', ')}`
    );

    res.on('close', () => {
      this.removeClient(clientId);
      // Decrement per-IP count
      const currentCount = this.ipConnectionCounts.get(ip) || 1;
      if (currentCount <= 1) {
        this.ipConnectionCounts.delete(ip);
      } else {
        this.ipConnectionCounts.set(ip, currentCount - 1);
      }
    });

    this.ensureHeartbeat();
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  setShuttingDown(value: boolean): void {
    this.shuttingDown = value;
  }

  checkCapacity(ip: string): { allowed: boolean; status?: number; message?: string; retryAfterSeconds?: number } {
    if (this.shuttingDown) {
      return { allowed: false, status: 503, message: 'Server is shutting down' };
    }

    if (this.clients.size >= this.globalMaxConnections) {
      return { allowed: false, status: 503, message: 'Server at capacity', retryAfterSeconds: 30 };
    }

    const ipCount = this.ipConnectionCounts.get(ip) || 0;
    if (ipCount >= this.maxConnectionsPerIp) {
      return { allowed: false, status: 429, message: 'Too many connections from this IP', retryAfterSeconds: 60 };
    }

    return { allowed: true };
  }

  initRedisSubscription(): void {
    if (!isRedisAvailable()) {
      return;
    }

    const subscriber = getSubscriber();
    if (!subscriber) {
      return;
    }

    subscriber.subscribe('sse-broadcast', (err) => {
      if (err) {
        logger.error('Failed to subscribe to Redis SSE channel', err);
      }
    });

    subscriber.on('message', (_channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'broadcast') {
          this.broadcast(data.event, data.payload);
        } else if (data.type === 'broadcastToStream') {
          this.broadcastToStream(data.streamId, data.event, data.payload);
        } else if (data.type === 'broadcastToUser') {
          this.broadcastToUser(data.publicKey, data.event, data.payload);
        }
      } catch (error) {
        logger.error('Failed to parse Redis SSE message', error);
      }
    });
  }

  sendReconnectToAll(): void {
    this.shuttingDown = true;
    this.broadcast('reconnect', { timestamp: Date.now() });
  }

  broadcastToAdmin(event: string, data: unknown): void {
    this.broadcast(event, data, (client) =>
      client.subscriptions.has('admin') || client.subscriptions.has('*')
    );
  }

  getActiveIpCount(): number {
    return this.ipConnectionCounts.size;
  }

  getPerIpPeakConnections(): Map<string, number> {
    return this.ipPeakConnections;
  }

  getMaxConnections(): number {
    return this.globalMaxConnections;
  }

  sendHeartbeat(): void {
    const message = ': heartbeat\n\n';

    for (const client of this.clients.values()) {
      this.writeToClient(client, message);
    }
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
    this.broadcast(event, data, (client) =>
      client.subscriptions.has(streamId) || client.subscriptions.has('*')
    );
  }

  broadcastToUser(publicKey: string, event: string, data: unknown): void {
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
      this.sendHeartbeat();
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
