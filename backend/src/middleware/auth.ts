import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import logger from '../logger.js';

const isProduction = process.env.NODE_ENV === 'production';
const rawJwtSecret = process.env.JWT_SECRET;

let JWT_SECRET: string;

if (isProduction) {
  if (!rawJwtSecret) {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  if (Buffer.from(rawJwtSecret).length < 32) {
    throw new Error('JWT_SECRET must be at least 32 bytes long in production');
  }
  JWT_SECRET = rawJwtSecret;
} else {
  if (!rawJwtSecret) {
    logger.warn('[Auth] JWT_SECRET not set — using random secret; tokens will NOT survive server restart');
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
  } else {
    if (Buffer.from(rawJwtSecret).length < 32) {
      logger.warn('[Auth] JWT_SECRET is less than 32 bytes long; consider using a stronger secret');
    }
    JWT_SECRET = rawJwtSecret;
  }
}

const JWT_EXPIRY_SECONDS = 3600; // 1 hour max per spec

const STELLAR_NETWORK =
  process.env.STELLAR_NETWORK === 'mainnet'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

// In-memory challenge store: publicKey -> { nonce, expiresAt }
const challenges = new Map<string, { nonce: string; expiresAt: number }>();
const DEFAULT_CHALLENGE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let challengeSweepTimer: NodeJS.Timeout | undefined;

function resolveChallengeSweepIntervalMs(): number {
  const raw = process.env.AUTH_CHALLENGE_SWEEP_INTERVAL_MS;
  if (!raw) return DEFAULT_CHALLENGE_SWEEP_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CHALLENGE_SWEEP_INTERVAL_MS;
}

export function sweepExpiredChallenges(now = Date.now()): number {
  let deleted = 0;
  for (const [publicKey, challenge] of challenges.entries()) {
    if (challenge.expiresAt < now) {
      challenges.delete(publicKey);
      deleted += 1;
    }
  }
  return deleted;
}

export function startChallengeSweep(intervalMs = resolveChallengeSweepIntervalMs()): void {
  if (challengeSweepTimer) return;
  challengeSweepTimer = setInterval(() => {
    sweepExpiredChallenges();
  }, intervalMs);
  challengeSweepTimer.unref?.();
}

export function stopChallengeSweep(): void {
  if (!challengeSweepTimer) return;
  clearInterval(challengeSweepTimer);
  challengeSweepTimer = undefined;
}

startChallengeSweep();

// ─── Minimal JWT (no external dep) ──────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64url');
}

export function signJwt(payload: object): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${b64url(sig)}`;
}

export function verifyJwt(token: string): { publicKey: string } | null {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest();
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'base64url'), expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { publicKey: payload.sub };
  } catch {
    return null;
  }
}

// ─── Challenge / Verify handlers ────────────────────────────────────────────

export function issueChallenge(req: Request, res: Response): void {
  const { publicKey } = req.body as { publicKey?: string };
  if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    res.status(400).json({ error: 'Invalid publicKey' });
    return;
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  challenges.set(publicKey, { nonce, expiresAt: Date.now() + 60_000 }); // 60s to sign
  res.json({ nonce, expiresAt: Date.now() + 60_000 });
}

export const __authChallengeTestUtils = {
  challenges,
  startChallengeSweep,
  stopChallengeSweep,
  sweepExpiredChallenges,
};

export function verifyChallenge(req: Request, res: Response): void {
  const { publicKey, signedTransaction } = req.body as {
    publicKey?: string;
    signedTransaction?: string;
  };

  if (!publicKey || !signedTransaction) {
    res.status(400).json({ error: 'publicKey and signedTransaction required' });
    return;
  }

  const challenge = challenges.get(publicKey);
  if (!challenge || challenge.expiresAt < Date.now()) {
    res.status(401).json({ error: 'Challenge expired or not found' });
    return;
  }

  try {
    const tx = StellarSdk.TransactionBuilder.fromXDR(
      signedTransaction,
      STELLAR_NETWORK,
    ) as StellarSdk.Transaction;

    if (tx.source !== publicKey) {
      res.status(401).json({ error: 'Transaction source does not match publicKey' });
      return;
    }

    // Verify the manage_data op contains our nonce
    const op = tx.operations[0] as StellarSdk.Operation.ManageData | undefined;
    if (!op || op.type !== 'manageData' || op.value?.toString('hex') !== challenge.nonce) {
      res.status(401).json({ error: 'Invalid challenge nonce in transaction' });
      return;
    }

    const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
    const txHash = tx.hash();
    const valid = tx.signatures.some((s) => {
      try { return keypair.verify(txHash, s.signature()); } catch { return false; }
    });

    if (!valid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    challenges.delete(publicKey);

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: publicKey, iat: now, exp: now + JWT_EXPIRY_SECONDS });
    res.json({ token, expiresIn: JWT_EXPIRY_SECONDS });
  } catch (err) {
    logger.error('[Auth] verifyChallenge error:', err);
    res.status(401).json({ error: 'Invalid signed transaction' });
  }
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token' });
    return;
  }
  const payload = verifyJwt(header.slice(7));
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    return;
  }
  (req as AuthenticatedRequest).user = { publicKey: payload.publicKey };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = (req as AuthenticatedRequest).user;
    const adminKey = process.env.ADMIN_PUBLIC_KEY;
    if (!adminKey || user.publicKey !== adminKey) {
      res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
      return;
    }
    next();
  });
}
