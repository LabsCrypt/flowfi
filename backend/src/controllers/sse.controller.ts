import type { Request, Response } from 'express';
import { sseService } from '../services/sse.service.js';
import { z } from 'zod';

const subscribeSchema = z.object({
  streams: z.array(z.string()).optional().default([]),
  users: z.array(z.string()).optional().default([]),
  all: z.boolean().optional().default(false),
});

export const subscribe = (req: Request, res: Response) => {
  try {
    const { streams, users, all } = subscribeSchema.parse(req.query);
    
    const subscriptions: string[] = [];
    
    if (all) {
      subscriptions.push('*');
    } else {
      subscriptions.push(...streams);
      subscriptions.push(...users.map(u => `user:${u}`));
    }

    const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    sseService.addClient(clientId, res, subscriptions);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({
        message: 'Invalid subscription parameters',
        errors: error.errors,
      });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
};
