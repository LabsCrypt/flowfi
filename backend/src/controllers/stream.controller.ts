import { Request, Response } from 'express';
import { createStreamSchema } from '../validators/stream.validator.js';
import { sseService } from '../services/sse.service.js';

export const createStream = async (req: Request, res: Response) => {
  try {
    const validatedData = createStreamSchema.parse(req.body);

    // Mock logging the indexed stream intention
    console.log('Indexing new stream intention:', validatedData);

    const mockStream = {
      id: '123',
      status: 'pending',
      ...validatedData
    };

    // Broadcast to SSE clients
    sseService.broadcastToStream(mockStream.id, 'stream.created', mockStream);
    sseService.broadcastToUser(validatedData.sender, 'stream.created', mockStream);
    sseService.broadcastToUser(validatedData.recipient, 'stream.created', mockStream);

    return res.status(201).json(mockStream);
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
