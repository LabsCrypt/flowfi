import type { Request, Response, NextFunction } from 'express';
import * as StellarSdk from '@stellar/stellar-sdk';
import type { AuthenticatedRequest, AuthUser } from '../types/auth.types.js';
import logger from '../logger.js';

/**
 * Stellar network passphrase (testnet or mainnet)
 */
const STELLAR_NETWORK = process.env.STELLAR_NETWORK === 'mainnet'
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;

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
 * Verify Stellar signed message and extract public key
 *
 * For SEP-10 authentication, the token should be a signed transaction envelope (XDR)
 * The transaction should contain:
 * - A manage_data operation with key "auth" and random value
 * - Source account is the authenticating user's public key
 * - Valid signature from the user's keypair
 */
function verifySignedMessage(token: string): AuthUser | null {
  try {
    // Decode the transaction envelope from base64 XDR
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      token,
      STELLAR_NETWORK
    ) as StellarSdk.Transaction;

    // Extract the source account (user's public key)
    const publicKey = transaction.source;

    // Verify the transaction has valid signatures
    const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
    const transactionHash = transaction.hash();

    // Check if transaction has at least one signature
    if (!transaction.signatures || transaction.signatures.length === 0) {
      logger.warn('Transaction has no signatures');
      return null;
    }

    // Verify at least one signature is valid for the source account
    const isValid = transaction.signatures.some((signature) => {
      try {
        return keypair.verify(transactionHash, signature.signature());
      } catch {
        return false;
      }
    });

    if (!isValid) {
      logger.warn('Invalid signature for public key:', publicKey);
      return null;
    }

    // Optional: Check transaction time bounds to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (transaction.timeBounds) {
      const minTime = parseInt(transaction.timeBounds.minTime);
      const maxTime = parseInt(transaction.timeBounds.maxTime);

      if (minTime && now < minTime) {
        logger.warn('Transaction not yet valid');
        return null;
      }

      if (maxTime && now > maxTime) {
        logger.warn('Transaction expired');
        return null;
      }
    }

    return { publicKey };
  } catch (error) {
    logger.error('Error verifying signed message:', error);
    return null;
  }
}

/**
 * Authentication middleware
 *
 * Extracts Bearer token from Authorization header,
 * verifies the Stellar signature, and attaches user to request.
 *
 * If authentication fails, returns 401 Unauthorized.
 */
export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Extract token from Bearer header
  const token = extractBearerToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Expected format: Bearer <signed_transaction>'
    });
    return;
  }

  // Verify signature and extract user
  const user = verifySignedMessage(token);

  if (!user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired signature'
    });
    return;
  }

  // Attach user to request
  (req as AuthenticatedRequest).user = user;

  logger.debug(`Authenticated user: ${user.publicKey}`);
  next();
};

/**
 * Optional authentication middleware
 *
 * Similar to authMiddleware but doesn't fail if token is missing.
 * Useful for endpoints that have optional authentication.
 */
export const optionalAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const token = extractBearerToken(req);

  if (token) {
    const user = verifySignedMessage(token);
    if (user) {
      (req as AuthenticatedRequest).user = user;
    }
  }

  next();
};
