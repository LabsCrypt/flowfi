import { Request, Response } from 'express';
import { createStreamSchema } from '../validators/stream.validator.js';

export const createStream = async (req: Request, res: Response) => {
  try {
    const validatedData = createStreamSchema.parse(req.body);

    // Mock logging the indexed stream intention
    console.log('Indexing new stream intention:', validatedData);

    // Return mock response as per requirements
    return res.status(201).json({
      id: '123',
      status: 'pending',
      ...validatedData
    });
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
