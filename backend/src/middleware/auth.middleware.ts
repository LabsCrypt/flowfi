import type { Request, Response, NextFunction } from 'express';
import { requireAuth, verifyJwt } from './auth.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1] ?? null;
}

/**
 * Authentication middleware alias
 *
 * Uses JWT authentication via the standard challenge/verify flow.
 */
export const authMiddleware = requireAuth;

/**
 * Optional authentication middleware
 *
 * Uses the same JWT validation as authMiddleware but does not fail when
 * no token is provided.
 */
export const optionalAuthMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const token = extractBearerToken(req);

  if (token) {
    const payload = verifyJwt(token);
    if (payload) {
      (req as AuthenticatedRequest).user = { publicKey: payload.publicKey };
    }
  }

  next();
};
