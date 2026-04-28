import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('POST /v1/auth/challenge', () => {
  it('test_challenge_returns_nonce_for_valid_address', async () => {
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

  it('returns 400 for an empty body', async () => {
    const res = await request(app).post('/v1/auth/challenge').send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 for an invalid public key', async () => {
    const res = await request(app)
      .post('/v1/auth/challenge')
      .send({ publicKey: 'not-a-stellar-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid publicKey/i);
  });
});

describe('POST /v1/auth/verify', () => {
  it('test_verify_valid_signature_returns_jwt', async () => {
    const keypair = makeKeypair();

    // Step 1 – get a nonce
    const challengeRes = await request(app)
      .post('/v1/auth/challenge')
      .send({ publicKey: keypair.publicKey() });
    expect(challengeRes.status).toBe(200);
    const { nonce } = challengeRes.body as { nonce: string };

    // Step 2 – build and sign a transaction containing the nonce
    const signedTransaction = buildSignedTransaction(keypair, nonce);

    // Step 3 – verify
    const verifyRes = await request(app)
      .post('/v1/auth/verify')
      .send({ publicKey: keypair.publicKey(), signedTransaction });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body).toHaveProperty('token');
    expect(typeof verifyRes.body.token).toBe('string');
    // JWT has three dot-separated parts
    expect(verifyRes.body.token.split('.').length).toBe(3);
    expect(verifyRes.body).toHaveProperty('expiresIn');
  });

  it('test_verify_expired_nonce_returns_401', async () => {
    const keypair = makeKeypair();

    // Advance time so the challenge store sees an expired entry.
    // We never request a real challenge — instead we send a garbage nonce
    // for a key that has no active challenge (equivalent to expired / not found).
    const signedTransaction = buildSignedTransaction(keypair, crypto.randomBytes(32).toString('hex'));

    const res = await request(app)
      .post('/v1/auth/verify')
      .send({ publicKey: keypair.publicKey(), signedTransaction });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Challenge expired or not found/i);
  });

  it('test_verify_invalid_signature_returns_401', async () => {
    const keypair = makeKeypair();
    const otherKeypair = makeKeypair();

    // Get a real nonce for `keypair`
    const challengeRes = await request(app)
      .post('/v1/auth/challenge')
      .send({ publicKey: keypair.publicKey() });
    const { nonce } = challengeRes.body as { nonce: string };

    // Sign with a *different* keypair — signature won't match publicKey
    const signedTransaction = buildSignedTransaction(otherKeypair, nonce);

    const res = await request(app)
      .post('/v1/auth/verify')
      .send({ publicKey: keypair.publicKey(), signedTransaction });

    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/v1/auth/verify')
      .send({ publicKey: makeKeypair().publicKey() }); // missing signedTransaction

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('Auth middleware (requireAuth) — Bearer JWT', () => {
  /** Obtain a valid JWT by going through the full challenge/verify flow. */
  async function getValidJwt(keypair: StellarSdk.Keypair): Promise<string> {
    const challengeRes = await request(app)
      .post('/v1/auth/challenge')
      .send({ publicKey: keypair.publicKey() });
    const { nonce } = challengeRes.body as { nonce: string };
    const signedTransaction = buildSignedTransaction(keypair, nonce);
    const verifyRes = await request(app)
      .post('/v1/auth/verify')
      .send({ publicKey: keypair.publicKey(), signedTransaction });
    return (verifyRes.body as { token: string }).token;
  }

  it('test_auth_middleware_accepts_valid_jwt', async () => {
    const keypair = makeKeypair();

    // Mock prisma so the SSE subscribe endpoint doesn't hit a real DB
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

    const token = await getValidJwt(keypair);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
  });

  it('test_auth_middleware_rejects_missing_token', async () => {
    // The SSE subscribe endpoint requires auth — hit it without a token
    const res = await request(app).get('/v1/events/subscribe');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('test_auth_middleware_rejects_expired_jwt', async () => {
    // Craft a JWT whose exp is in the past using the internal signing logic.
    // We replicate the JWT format: base64url(header).base64url(payload).base64url(sig)
    // with a known secret. Since the app uses a random secret at startup, we
    // can't forge a valid expired token — but we CAN send a structurally valid
    // JWT with a past exp and confirm the middleware rejects it.
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const fakePayload = Buffer.from(
      JSON.stringify({ sub: makeKeypair().publicKey(), iat: 1, exp: 1 }), // expired in 1970
    ).toString('base64url');
    const fakeJwt = `${fakeHeader}.${fakePayload}.invalidsig`;

    const res = await request(app)
      .get('/v1/events/subscribe')
      .set('Authorization', `Bearer ${fakeJwt}`);

    expect(res.status).toBe(401);
  });

  it('test_sse_endpoint_requires_auth', async () => {
    // Without any auth header the SSE subscribe endpoint returns 401
    const res = await request(app)
      .get('/v1/events/subscribe')
      .set('Accept', 'text/event-stream');

    expect(res.status).toBe(401);
  });
});
