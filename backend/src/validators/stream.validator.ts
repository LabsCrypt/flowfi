import { z } from 'zod';

export const createStreamSchema = z.object({
  streamId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(v => parseInt(v))]),
  sender: z.string().min(1, 'Sender address is required'),
  recipient: z.string().min(1, 'Recipient address is required'),
  tokenAddress: z.string().min(1, 'Token address is required'),
  ratePerSecond: z.string().regex(/^\d+$/, 'Rate must be a positive integer as string'),
  depositedAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer as string'),
  startTime: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(v => parseInt(v))]),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;
