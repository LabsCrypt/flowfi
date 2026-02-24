import { z } from 'zod';

export const createStreamSchema = z.object({
  sender: z.string().min(1, 'Sender address is required'),
  recipient: z.string().min(1, 'Recipient address is required'),
  tokenAddress: z.string().min(1, 'Token address is required'),
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer as string'),
  duration: z.number().int().positive('Duration must be a positive integer in seconds'),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;
