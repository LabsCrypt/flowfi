import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import app from '../src/app.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a random valid Stellar keypair. */
function makeKeypair() {
  return StellarSdk.Keypair.random();
}

/**
 * Build a signed Stellar transaction that embeds `nonce` in a manage_data op,
 * then return its base64-XDR string.
 */
function buildSignedTransaction(keypair: StellarSdk.Keypair, nonce: string): string {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.manageData({
        name: 'auth',
        value: Buffer.from(nonce, 'hex'),
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Authentication & Middleware Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /v1/auth/challenge', () => {
    it('test_challenge_returns_nonce_for_valid_stellar_address', async () => {
      const keypair = makeKeypair();

      const res = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('nonce');
      expect(typeof res.body.nonce).toBe('string');
      expect(res.body.nonce).toHaveLength(64); // 32 bytes hex
      expect(res.body).toHaveProperty('expiresAt');
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('POST /v1/auth/verify', () => {
    it('test_verify_valid_signature_returns_jwt', async () => {
      const keypair = makeKeypair();

      // Step 1 – get a nonce
      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };

      // Step 2 – build and sign a transaction containing the nonce
      const signedTransaction = buildSignedTransaction(keypair, nonce);

      // Step 3 – verify (with mocked signature verification for compliance)
      const verifySpy = vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const verifyRes = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body).toHaveProperty('token');
      expect(verifyRes.body.token.split('.').length).toBe(3);
      expect(verifyRes.body).toHaveProperty('expiresIn');
      expect(verifySpy).toHaveBeenCalled();
    });

    it('test_verify_expired_nonce_returns_401', async () => {
      const keypair = makeKeypair();
      // Sending a nonce for a key that hasn't requested one (effectively expired/not found)
      const signedTransaction = buildSignedTransaction(keypair, crypto.randomBytes(32).toString('hex'));

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Challenge expired or not found/i);
    });

    it('test_verify_invalid_signature_returns_401', async () => {
      const keypair = makeKeypair();

      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };

      const signedTransaction = buildSignedTransaction(keypair, nonce);

      // Force verification failure
      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(false);

      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid signature/i);
    });

    it('test_verify_wrong_address_returns_401', async () => {
      const keypair = makeKeypair();
      const otherKeypair = makeKeypair();

      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };

      // Transaction source is otherKeypair
      const signedTransaction = buildSignedTransaction(otherKeypair, nonce);

      // Payload publicKey is keypair
      const res = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Transaction source does not match publicKey/i);
    });
  });

  describe('Auth Middleware (requireAuth)', () => {
    async function getValidJwt(keypair: StellarSdk.Keypair): Promise<string> {
      const challengeRes = await request(app)
        .post('/v1/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      const { nonce } = challengeRes.body as { nonce: string };
      const signedTransaction = buildSignedTransaction(keypair, nonce);

      vi.spyOn(StellarSdk.Keypair.prototype, 'verify').mockReturnValue(true);

      const verifyRes = await request(app)
        .post('/v1/auth/verify')
        .send({ publicKey: keypair.publicKey(), signedTransaction });
      return (verifyRes.body as { token: string }).token;
    }

    it('test_auth_middleware_accepts_valid_jwt', async () => {
      const keypair = makeKeypair();
      const token = await getValidJwt(keypair);

      // Mocking prisma for any downstream dependency
      vi.mock('../src/lib/prisma.js', () => ({
        default: {
          stream: { findMany: vi.fn().mockResolvedValue([]) },
          $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
          $disconnect: vi.fn(),
        },
        prisma: {
          stream: { findMany: vi.fn().mockResolvedValue([]) },
          $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
          $disconnect: vi.fn(),
        },
      }));

      // Any route that uses requireAuth
      const res = await request(app)
        .get('/v1/events/subscribe')
        .set('Authorization', `Bearer ${token}`);

      // Even if it returns 200 or 404/500, we check that it's NOT 401
      expect(res.status).not.toBe(401);
    });

    it('test_auth_middleware_rejects_expired_jwt', async () => {
      const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const fakePayload = Buffer.from(
        JSON.stringify({ sub: makeKeypair().publicKey(), iat: 1, exp: 1 }), // 1970
      ).toString('base64url');
      const fakeJwt = `${fakeHeader}.${fakePayload}.invalidsig`;

      const res = await request(app)
        .get('/v1/events/subscribe')
        .set('Authorization', `Bearer ${fakeJwt}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or expired token/i);
    });

    it('test_auth_middleware_rejects_missing_header', async () => {
      const res = await request(app).get('/v1/events/subscribe');
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Missing Bearer token/i);
    });

    it('test_sse_subscribe_without_token_returns_401', async () => {
      const res = await request(app)
        .get('/v1/events/subscribe')
        .set('Accept', 'text/event-stream');

      expect(res.status).toBe(401);
    });
  });
});
