import { z } from 'zod';
import { parseStreamId } from '../lib/stream-id.js';

const MAX_I128 = BigInt('170141183460469231731687303715884105727');

export const createStreamSchema = z.object({
  streamId: z
    .union([z.number(), z.string(), z.bigint()])
    .transform((v, ctx) => {
      const parsed = parseStreamId(v);
      if (parsed === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'streamId must be a non-negative integer',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  sender: z.string().min(1, 'Sender address is required'),
  recipient: z.string().min(1, 'Recipient address is required'),
  tokenAddress: z.string().min(1, 'Token address is required'),
  ratePerSecond: z
    .string()
    .regex(/^\d+$/, 'Rate must be a positive integer as string')
    .refine(
      (val) => {
        try {
          return BigInt(val) <= MAX_I128;
        } catch {
          return true;
        }
      },
      { message: 'Rate exceeds maximum allowed value' },
    ),
  depositedAmount: z.string().regex(/^\d+$/, 'Amount must be a positive integer as string'),
  startTime: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(v => parseInt(v))]),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;
