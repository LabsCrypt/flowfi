import { z } from 'zod';

export const createStreamSchema = z.object({
  sender: z.string().min(1, 'Sender address is required'),
  recipient: z.string().min(1, 'Recipient address is required'),
  amount: z.number().positive('Amount must be positive'),
  token: z.string().min(1, 'Token is required'),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;
