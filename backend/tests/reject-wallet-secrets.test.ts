import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Account,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import {
  findWalletSecret,
  rejectWalletSecrets,
} from '../src/middleware/reject-wallet-secrets.middleware.js';
import app from '../src/app.js';
import logger from '../src/logger.js';

// Keep the real `requestContext` named export (used by requestId middleware);
// only the default winston logger is replaced with spies.
vi.mock('../src/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/logger.js')>();
  return {
    ...original,
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

// Pinned copies of the middleware's user-facing strings so any change to the
// envelope is a deliberate, test-reviewed edit.
const EXPECTED_MESSAGE =
  'Sign the transaction in your wallet instead: POST /v1/streams/simulate returns an unsigned, ' +
  'footprint-annotated XDR; sign it and send the result as `signedXdr`. FlowFi never accepts a private key.';
const EXPECTED_REASON = 'The API does not accept Stellar secret keys (issue #1845).';

interface FakeReqInput {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  path?: string;
  headers?: Record<string, string | string[]>;
  method?: string;
}

function fakeReq(input: FakeReqInput): Request {
  return {
    method: input.method ?? 'POST',
    path: input.path ?? '/v1/streams/123/cancel',
    query: input.query ?? {},
    params: input.params ?? {},
    body: input.body,
    headers: input.headers ?? {},
  } as unknown as Request;
}

interface CapturedResponse {
  statusCode: number;
  jsonBody: unknown;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeFakeRes(): CapturedResponse {
  const captured = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    status: vi.fn((code: number) => {
      captured.statusCode = code;
      return captured;
    }),
    json: vi.fn((body: unknown) => {
      captured.jsonBody = body;
      return captured;
    }),
  };
  return captured as unknown as CapturedResponse;
}

function mockCallBlob(): string {
  const calls = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return JSON.stringify(calls);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findWalletSecret — positive detection', () => {
  // Source-as-implemented: object-key hits come back as the bare key name
  // (the parent path is only prefixed for array elements), while headers
  // report 'header.*' and URL segments report 'path'.
  it('flags a top-level body.senderSecret holding a real v0 secret key', () => {
    const secret = Keypair.random().secret();
    expect(secret).toMatch(/^S[A-Z2-7]{55}$/);
    expect(findWalletSecret(fakeReq({ body: { senderSecret: secret } }))).toBe(
      'senderSecret',
    );
  });

  it('flags a nested secret key', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({ body: { config: { keys: { secret } } } });
    expect(findWalletSecret(req)).toBe('secret');
  });

  it('flags a secret key inside an array element', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({
      body: { payouts: [{ memo: 'rent' }, { key: secret }] },
    });
    expect(findWalletSecret(req)).toBe('key');
  });

  it('flags a secret key in the query string', () => {
    const secret = Keypair.random().secret();
    expect(findWalletSecret(fakeReq({ query: { senderSecret: secret } }))).toBe(
      'senderSecret',
    );
  });

  it('flags a secret key in a URL path segment (route params included)', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({ path: `/v1/streams/${secret}/cancel` });
    expect(findWalletSecret(req)).toBe('path');
  });

  it('flags a secret key in a header', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({ headers: { 'x-sender-secret': secret } });
    expect(findWalletSecret(req)).toBe('header.x-sender-secret');
  });

  it('flags a secret key in one entry of a multi-valued header', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({ headers: { 'x-creds': ['bearer ok', secret] } });
    expect(findWalletSecret(req)).toBe('header.x-creds');
  });

  // The source pattern is /^S[A-Z2-7]{55}$|^M[A-Z2-7]{93}$/ — med25519 (M) secrets
  // are deliberately refused too, so this shape must be flagged, not tolerated.
  it('flags a 94-char med25519 (M-prefixed) secret key', () => {
    const med25519 = `M${'A'.repeat(93)}`;
    expect(med25519).toHaveLength(94);
    expect(findWalletSecret(fakeReq({ body: { xkey: med25519 } }))).toBe('xkey');
  });

  it('terminates on a cyclic body graph and still finds the secret', () => {
    const secret = Keypair.random().secret();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    cyclic['secret'] = secret;

    const startedAt = Date.now();
    const at = findWalletSecret(fakeReq({ body: cyclic }));
    const elapsedMs = Date.now() - startedAt;

    expect(at).toBe('secret');
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('findWalletSecret — negative (must not false-positive)', () => {
  it('does not flag a G-prefixed public key of the same length', () => {
    const publicKey = Keypair.random().publicKey();
    expect(publicKey).toHaveLength(56);
    expect(findWalletSecret(fakeReq({ body: { sender: publicKey } }))).toBeNull();
  });

  it('does not flag a C-prefixed contract id', () => {
    const contractId = StrKey.encodeContract(crypto.randomBytes(32));
    expect(findWalletSecret(fakeReq({ body: { contract: contractId } }))).toBeNull();
  });

  it('does not flag a 64-hex webhook signing secret', () => {
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    expect(findWalletSecret(fakeReq({ body: { secret: webhookSecret } }))).toBeNull();
  });

  // The anchored pattern cannot match a >200-char string, so a real unsigned
  // XDR blob of this shape can never trip the scanner.
  it('does not flag a real multi-hundred-char base64 transaction XDR', () => {
    const source = Keypair.random();
    const contract = new Contract(StrKey.encodeContract(crypto.randomBytes(32)));
    const tx = new TransactionBuilder(new Account(source.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: Networks.FUTURENET,
    })
      .addOperation(contract.call('cancel'))
      .addOperation(contract.call('topUp'))
      .addOperation(contract.call('distribute'))
      .setTimeout(300)
      .build();
    const xdr = tx.toXDR();
    expect(xdr.length).toBeGreaterThan(200);
    expect(findWalletSecret(fakeReq({ body: { signedXdr: xdr } }))).toBeNull();
  });

  it('does not flag an opaque JWT-shaped token', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(findWalletSecret(fakeReq({ headers: { authorization: jwt }, body: { token: jwt } }))).toBeNull();
  });

  it('passes through a clean request entirely', () => {
    const clean = fakeReq({
      body: { signedXdr: 'AAAAAGV1nQJ2Z3F0dXliMG5jaGtoMnJkM2s0dHV2OHk=' },
      query: { page: '2' },
      headers: { 'content-type': 'application/json' },
    });
    expect(findWalletSecret(clean)).toBeNull();
  });
});

describe('rejectWalletSecrets middleware (unit)', () => {
  it('responds 400 with the WALLET_SECRET_NOT_ACCEPTED envelope and never calls next', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({ body: { senderSecret: secret } });
    const res = makeFakeRes();
    const next = vi.fn();

    rejectWalletSecrets(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      error: {
        code: 'WALLET_SECRET_NOT_ACCEPTED',
        message: EXPECTED_MESSAGE,
        details: { field: 'senderSecret', reason: EXPECTED_REASON },
      },
    });
  });

  it('logs the offending location but never the secret value', () => {
    const secret = Keypair.random().secret();
    const req = fakeReq({ body: { senderSecret: secret } });
    const res = makeFakeRes();

    rejectWalletSecrets(req, res as unknown as Response, vi.fn());

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('senderSecret'));
    expect(mockCallBlob()).not.toContain(secret);
  });

  it('calls next and writes nothing when no secret is present', () => {
    const req = fakeReq({ body: { signedXdr: 'AAAAAGV1nQJ2Z3F0dXliMG5jaGtoMnJkM2s0dHV2OHk=' } });
    const res = makeFakeRes();
    const next = vi.fn();

    rejectWalletSecrets(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.jsonBody).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('issue #1845 regression: no endpoint accepts a Stellar secret key', () => {
  // Minimal app mirroring app.ts's chain: JSON parser first, then the guard,
  // then a dummy handler that must only ever see key-free requests.
  const localApp = express();
  localApp.use(express.json());
  localApp.use(rejectWalletSecrets);
  localApp.post('/v1/streams/:streamId/cancel', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  it('blocks a secret key in the JSON body before the handler runs', async () => {
    const secret = Keypair.random().secret();
    const res = await request(localApp)
      .post('/v1/streams/123/cancel')
      .send({ senderSecret: secret });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WALLET_SECRET_NOT_ACCEPTED');
    expect(res.body.error.details.field).toBe('senderSecret');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('blocks a secret key in the (URL-encoded) query string', async () => {
    const secret = Keypair.random().secret();
    const res = await request(localApp).post(
      `/v1/streams/123/cancel?senderSecret=${encodeURIComponent(secret)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WALLET_SECRET_NOT_ACCEPTED');
    expect(res.body.error.details.field).toBe('senderSecret');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('blocks a secret key in a header', async () => {
    const secret = Keypair.random().secret();
    const res = await request(localApp)
      .post('/v1/streams/123/cancel')
      .set('x-sender-secret', secret)
      .send({ anything: true });

    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe('header.x-sender-secret');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('lets the wallet-signed flow through to the handler with 200', async () => {
    const res = await request(localApp)
      .post('/v1/streams/123/cancel')
      .send({ signedXdr: 'AAAAAGV1nQJ2Z3F0dXliMG5jaGtoMnJkM2s0dHV2OHk=' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('never leaks the rejected secret into the logger calls either', async () => {
    const secret = Keypair.random().secret();
    await request(localApp).post('/v1/streams/123/cancel').send({ senderSecret: secret });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(mockCallBlob()).not.toContain(secret);
  });
});

describe('real app wiring (src/app.ts)', () => {
  it('rejects a secret-key cancel body at the repo-wide middleware, before auth or routers', async () => {
    const secret = Keypair.random().secret();
    const res = await request(app)
      .post('/v1/streams/123/cancel')
      .send({ senderSecret: secret });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WALLET_SECRET_NOT_ACCEPTED');
    expect(res.body.error.message).toMatch(/FlowFi never accepts a private key/);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});
