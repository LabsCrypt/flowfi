import type { Request, Response } from 'express';
import { sseService } from '../services/sse.service.js';
import { prisma } from '../lib/prisma.js';
import { requestContext } from '../logger.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import { z } from 'zod';

const subscribeSchema = z.object({
  streams: z.array(z.string()).optional().default([]),
  users: z.array(z.string()).optional().default([]),
  all: z.boolean().optional().default(false),
});


function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0] ?? 'unknown';
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
}
export const subscribe = async (req: Request, res: Response) => {
  if (sseService.isShuttingDown()) {
    return res.status(503).json({ message: 'Server is shutting down, please reconnect shortly.' });
  }

  try {
    const sourceIp = getClientIp(req);
    const capacity = sseService.checkCapacity(sourceIp);
    if (!capacity.allowed) {
      if (capacity.retryAfterSeconds) {
        res.setHeader('Retry-After', String(capacity.retryAfterSeconds));
      }
      return res.status(capacity.status ?? 503).json({
        message: capacity.message ?? 'SSE connection rejected',
      });
    }

    const { publicKey } = (req as AuthenticatedRequest).user;
    const { streams, users, all } = subscribeSchema.parse(req.query);

    // Scope: only streams where the authenticated user is sender or recipient
    const ownedStreams = await prisma.stream.findMany({
      where: { OR: [{ sender: publicKey }, { recipient: publicKey }] },
      select: { streamId: true, sender: true, recipient: true },
    });
    const ownedIds = new Set(ownedStreams.map((s: { streamId: number }) => String(s.streamId)));
    const allowedUserKeys = new Set<string>([publicKey]);
    for (const stream of ownedStreams) {
      allowedUserKeys.add(stream.sender);
      allowedUserKeys.add(stream.recipient);
    }

    let subscriptions: string[];
    if (all) {
      // "all" still scoped to the user's own streams
      subscriptions = [...ownedIds];
    } else if (streams.length > 0) {
      // Only allow subscribing to streams the user owns
      subscriptions = streams.filter((id) => ownedIds.has(id));
    } else {
      subscriptions = [...ownedIds];
    }

    const userSubscriptions = new Set<string>([`user:${publicKey}`]);
    for (const key of users.filter((k) => allowedUserKeys.has(k))) {
      userSubscriptions.add(`user:${key}`);
    }
    subscriptions.push(...userSubscriptions);

    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const requestId = requestContext.getStore()?.requestId;
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId, requestId })}\n\n`);

    sseService.addClient(clientId, res, subscriptions, sourceIp);
    return;
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: 'Invalid subscription parameters',
        errors: error.issues,
      });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
};
