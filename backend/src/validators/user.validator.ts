import { z } from 'zod';

/**
 * Stellar Ed25519 account IDs are base32 strings: a `G` version byte prefix
 * followed by 55 characters from the RFC 4648 base32 alphabet, 56 in total.
 *
 * This is a format check only — it deliberately does not verify the trailing
 * CRC16 checksum, so callers must not treat a match as proof the key exists
 * or was typed correctly.
 */
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

export const STELLAR_PUBLIC_KEY_ERROR =
    'Invalid Stellar public key format: expected 56 base32 characters starting with "G"';

/**
 * Reusable schema for a Stellar account public key.
 *
 * Rejects malformed keys at the validation layer so they never reach the
 * controller or repository, where they would surface as opaque lookup misses
 * or be stored as-is.
 */
export const stellarPublicKeySchema = z
    .string({ message: 'publicKey is required and must be a string' })
    .regex(STELLAR_PUBLIC_KEY_REGEX, STELLAR_PUBLIC_KEY_ERROR);

export const registerUserSchema = z.object({
    publicKey: stellarPublicKeySchema,
});

export type RegisterUserInput = z.infer<typeof registerUserSchema>;
