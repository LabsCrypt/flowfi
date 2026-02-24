import type { Response } from 'express';
import logger from '../logger.js';

interface SSEClient {
  id: string;
  res: Response;
  subscriptions: Set<string>;
}

class SSEService {
  private clients: Map<string, SSEClient> = new Map();

  addClient(clientId: string, res: Response, subscriptions: string[] = []): void {
    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
    };

    this.clients.set(clientId, client);
    logger.info(`SSE client connected: ${clientId}, subscriptions: ${subscriptions.join(', ')}`);

    res.on('close', () => {
      this.clients.delete(clientId);
      logger.info(`SSE client disconnected: ${clientId}`);
    });
  }

  broadcast(event: string, data: any, filter?: (client: SSEClient) => boolean): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    
    for (const client of this.clients.values()) {
      if (!filter || filter(client)) {
        client.res.write(message);
      }
    }
  }

  broadcastToStream(streamId: string, event: string, data: any): void {
    this.broadcast(event, data, (client) => 
      client.subscriptions.has(streamId) || client.subscriptions.has('*')
    );
  }

  broadcastToUser(publicKey: string, event: string, data: any): void {
    this.broadcast(event, data, (client) => 
      client.subscriptions.has(`user:${publicKey}`) || client.subscriptions.has('*')
    );
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export const sseService = new SSEService();
