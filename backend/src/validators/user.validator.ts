import { z } from 'zod';

export const registerUserSchema = z.object({
    publicKey: z.string().min(50, 'Invalid Stellar public key').regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
});

export type RegisterUserInput = z.infer<typeof registerUserSchema>;
