import type { Response } from 'express';
import logger from '../logger.js';

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
  private shuttingDown = false;
  private ipConnections: Map<string, number> = new Map();
  private perIpPeakConnections: Map<string, number> = new Map();
  private maxConnections = 1000;
  private maxConnectionsPerIp = 10;

  addClient(clientId: string, res: Response, subscriptions: string[], ip?: string): void {
    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
      paused: false,
    };

    this.clients.set(clientId, client);
    
    if (ip) {
      const currentCount = this.ipConnections.get(ip) || 0;
      this.ipConnections.set(ip, currentCount + 1);
      const peak = this.perIpPeakConnections.get(ip) || 0;
      if (currentCount + 1 > peak) {
        this.perIpPeakConnections.set(ip, currentCount + 1);
      }
    }
    
    logger.info(
      `[SSEService] Connection opened: ${clientId}, ip: ${ip}, subscriptions: ${subscriptions.join(', ')}`
    );

    res.on('close', () => {
      this.removeClient(clientId, ip);
    });

    this.ensureHeartbeat();
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

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  checkCapacity(sourceIp: string): { allowed: boolean; retryAfterSeconds?: number } {
    if (this.shuttingDown) {
      return { allowed: false, retryAfterSeconds: 30 };
    }

    if (this.clients.size >= this.maxConnections) {
      return { allowed: false, retryAfterSeconds: 60 };
    }

    const ipCount = this.ipConnections.get(sourceIp) || 0;
    if (ipCount >= this.maxConnectionsPerIp) {
      return { allowed: false, retryAfterSeconds: 300 };
    }

    return { allowed: true };
  }

  async initRedisSubscription(): Promise<void> {
    // Redis subscription logic would go here
    // For now, this is a no-op placeholder
  }

  sendReconnectToAll(): void {
    this.shuttingDown = true;
    this.broadcast('reconnect', { message: 'Server is restarting, please reconnect' });
  }

  getActiveIpCount(): number {
    return this.ipConnections.size;
  }

  getPerIpPeakConnections(): number {
    let total = 0;
    for (const peak of this.perIpPeakConnections.values()) {
      total += peak;
    }
    return total;
  }

  getMaxConnections(): number {
    return this.maxConnections;
  }

  broadcastToAdmin(event: string, data: unknown): void {
    this.broadcast(event, data, (client) =>
      client.subscriptions.has('admin') || client.subscriptions.has('*')
    );
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

  private removeClient(clientId: string, ip?: string, reason?: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.clients.delete(clientId);
    
    if (ip) {
      const currentCount = this.ipConnections.get(ip) || 0;
      if (currentCount > 0) {
        this.ipConnections.set(ip, currentCount - 1);
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
