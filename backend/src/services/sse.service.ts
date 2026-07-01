import type { Response } from 'express';
import logger from '../logger.js';
import { isRedisAvailable, getPublisher, getSubscriber } from '../lib/redis.js';

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

    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
      paused: false,
    };

    this.clients.set(clientId, client);
    logger.info(
      `[SSEService] Connection opened: ${clientId}, ip: ${ip}, subscriptions: ${subscriptions.join(', ')}`
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
