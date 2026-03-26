import type { Request } from 'express';

/**
 * User object attached to authenticated requests
 */
export interface AuthUser {
  publicKey: string;
  id?: string;
}

/**
 * Extended Express Request with authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

/**
 * SEP-10 Challenge Transaction payload
 */
export interface SEP10ChallengePayload {
  transaction: string;
  network_passphrase: string;
}

/**
 * SEP-10 Token payload
 */
export interface SEP10TokenPayload {
  sub: string; // Stellar public key
  iat: number; // Issued at
  exp: number; // Expiration
}
