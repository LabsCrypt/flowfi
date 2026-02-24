import type { Response } from 'express';
import { createStreamSchema } from '../validators/stream.validator.js';
import { sseService } from '../services/sse.service.js';
import type { SandboxRequest } from '../middleware/sandbox.middleware.js';
import { isSandboxRequest } from '../middleware/sandbox.middleware.js';

/**
 * Helper to add sandbox metadata to response
 */
function addSandboxMetadata(data: any, isSandbox: boolean): any {
  if (!isSandbox) {
    return data;
  }

  return {
    ...data,
    _sandbox: {
      mode: true,
      warning: 'This is sandbox data and does not affect production',
      timestamp: new Date().toISOString(),
    },
  };
}

export const createStream = async (req: SandboxRequest, res: Response) => {
  try {
    const validatedData = createStreamSchema.parse(req.body);
    const isSandbox = isSandboxRequest(req);

    // Log sandbox mode
    if (isSandbox) {
      console.log('[SANDBOX] Indexing new stream intention:', validatedData);
    } else {
      console.log('Indexing new stream intention:', validatedData);
    }

    const mockStream = {
      id: '123',
      status: 'pending',
      ...validatedData
    };

    // Broadcast to SSE clients (sandbox events are also broadcasted but clearly marked)
    const streamData = addSandboxMetadata(mockStream, isSandbox);
    sseService.broadcastToStream(mockStream.id, 'stream.created', streamData);
    sseService.broadcastToUser(validatedData.sender, 'stream.created', streamData);
    sseService.broadcastToUser(validatedData.recipient, 'stream.created', streamData);

    return res.status(201).json(addSandboxMetadata(mockStream, isSandbox));
  } catch (error: any) {
    if (error.name === 'ZodError' || error.issues) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: error.errors || error.issues
      });
    }
    
    return res.status(500).json({
      message: 'Internal server error'
    });
  }
};
