/**
 * Webhook route authorization and tenancy (issue #1846).
 *
 * Two promises are checked here:
 *  1. none of the seven `/v1/webhooks` endpoints is reachable without a valid
 *     SEP-10 bearer token, and
 *  2. the wallet that owns a subscription comes from the token alone — a
 *     `userAddress` in the body, query, or route is inert, so one tenant
 *     cannot read, retarget, disable, re-secret, or fire another's webhook.
 *
 * Prisma is replaced by a fake that enforces its `where` clauses the way Postgres
 * would, so a missing owner filter shows up as data leaking into the response
 * rather than as a mocked call assertion that passes for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';

interface SubscriptionRow {
  id: string;
  userAddress: string;
  targetUrl: string;
  secretKey: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: Date;
}

interface DeliveryRow {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  attempts: number;
  responseStatus: number | null;
  deliveredAt: Date | null;
  error: string | null;
  createdAt: Date;
}

const { subscriptions, deliveries, prismaMock } = vi.hoisted(() => ({
  subscriptions: [] as unknown[],
  deliveries: [] as unknown[],
  prismaMock: {} as Record<string, any>,
}));

vi.mock('../src/lib/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

// The global limiter is 100 requests per minute per IP and this suite makes
// more than that to prove authorization, not throttling, behaviour. The
// limiter is covered by tests/rate-limiter.test.ts.
vi.mock('../src/middleware/rate-limiter.middleware.js', () => ({
  globalRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  healthRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitHandler: () => undefined,
}));

// The service re-validates every target at dispatch time; answer with a public
// address so the guard runs without live DNS.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34' }],
}));

import app from '../src/app.js';

type Where = Partial<Pick<SubscriptionRow, 'id' | 'userAddress' | 'isActive'>>;

/** The fake table as typed rows, for assertions about what was actually stored. */
const rows = () => subscriptions as unknown as SubscriptionRow[];

function seed(): void {
  subscriptions.length = 0;
  deliveries.length = 0;

  const table = rows();
  const sent = deliveries as unknown as DeliveryRow[];
  const owned = (where: Where) =>
    table.filter(
      (row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.userAddress === undefined || row.userAddress === where.userAddress) &&
        (where.isActive === undefined || row.isActive === where.isActive),
    );

  prismaMock.webhookSubscription = {
    create: async ({ data }: { data: Omit<SubscriptionRow, 'id' | 'createdAt'> }) => {
      const row: SubscriptionRow = {
        id: `wh_${table.length + 1}`,
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
        ...data,
      };
      table.push(row);
      return row;
    },
    findMany: async ({ where }: { where: { userAddress: string } }) =>
      owned(where).map((row) => ({ ...row })),
    findFirst: async ({ where }: { where: Where }) => {
      const found = owned(where)[0];
      return found ? { ...found } : null;
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<SubscriptionRow> }) => {
      const target = owned(where);
      for (const row of target) Object.assign(row, data);
      return { count: target.length };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<SubscriptionRow> }) => {
      const row = table.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('P2025: no matching subscription');
      return Object.assign(row, data);
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = table.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('P2025: no matching subscription');
      return { ...row };
    },
  };

  prismaMock.webhookDelivery = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `dl_${sent.length + 1}`,
        responseStatus: null,
        deliveredAt: null,
        error: null,
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
        ...data,
      } as unknown as DeliveryRow;
      sent.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<DeliveryRow> }) => {
      const row = sent.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('P2025: no matching delivery');
      return Object.assign(row, data);
    },
    findMany: async ({ where }: { where: { subscriptionId: string } }) =>
      sent.filter((row) => row.subscriptionId === where.subscriptionId),
    count: async ({ where }: { where: { subscriptionId: string } }) =>
      sent.filter((row) => row.subscriptionId === where.subscriptionId).length,
  };
}

function signedTransaction(keypair: StellarSdk.Keypair, nonce: string): string {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.manageData({ name: 'auth', value: Buffer.from(nonce, 'hex') }),
    )
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

async function tokenFor(keypair: StellarSdk.Keypair): Promise<string> {
  const challenge = await request(app)
    .post('/v1/auth/challenge')
    .send({ publicKey: keypair.publicKey() });
  const verify = await request(app)
    .post('/v1/auth/verify')
    .send({
      publicKey: keypair.publicKey(),
      signedTransaction: signedTransaction(keypair, challenge.body.nonce as string),
    });
  expect(verify.status).toBe(200);
  return verify.body.token as string;
}

// The seven endpoints the issue enumerates, with the verb each is registered on.
const ENDPOINTS: ReadonlyArray<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string }> = [
  { method: 'post', path: '/v1/webhooks' },
  { method: 'get', path: '/v1/webhooks' },
  { method: 'delete', path: '/v1/webhooks/wh_1' },
  { method: 'patch', path: '/v1/webhooks/wh_1' },
  { method: 'post', path: '/v1/webhooks/wh_1/secret' },
  { method: 'get', path: '/v1/webhooks/wh_1/deliveries' },
  { method: 'post', path: '/v1/webhooks/wh_1/test' },
];

const BODY = { targetUrl: 'https://receiver.example/hook', eventTypes: ['CREATED'] };

describe('#1846 every webhook endpoint requires authentication', () => {
  beforeEach(seed);

  it.each(ENDPOINTS)('$method $path answers 401 with no token', async ({ method, path }) => {
    const call = request(app)[method](path);
    const response = method === 'get' ? await call : await call.send(BODY);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    // Nothing was stored while unauthenticated.
    expect(subscriptions).toHaveLength(0);
  });

  it.each(ENDPOINTS)('$method $path answers 401 for a forged token', async ({ method, path }) => {
    const call = request(app)[method](path).set('Authorization', 'Bearer not-a-jwt');
    const response = method === 'get' ? await call : await call.send(BODY);
    expect(response.status).toBe(401);
  });

  it('does not accept a token minted for a different network passphrase', async () => {
    const keypair = StellarSdk.Keypair.random();
    const account = new StellarSdk.Account(keypair.publicKey(), '0');
    const challenge = await request(app)
      .post('/v1/auth/challenge')
      .send({ publicKey: keypair.publicKey() });
    const wrongNetwork = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: 'auth',
          value: Buffer.from(challenge.body.nonce as string, 'hex'),
        }),
      )
      .setTimeout(60)
      .build();
    wrongNetwork.sign(keypair);

    const verify = await request(app)
      .post('/v1/auth/verify')
      .send({
        publicKey: keypair.publicKey(),
        signedTransaction: wrongNetwork.toXDR(),
      });
    expect(verify.status).toBe(401);
  });
});

describe('#1846 subscription ownership comes from the token, not the request', () => {
  const owner = StellarSdk.Keypair.random();
  const attacker = StellarSdk.Keypair.random();
  let ownerToken: string;
  let attackerToken: string;

  beforeEach(async () => {
    seed();
    ownerToken = await tokenFor(owner);
    attackerToken = await tokenFor(attacker);
  });

  it('stores a new subscription under the authenticated wallet', async () => {
    const created = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(BODY);

    expect(created.status).toBe(201);
    expect(created.body.subscription.userAddress).toBe(owner.publicKey());
    expect(subscriptions).toHaveLength(1);
  });

  it('ignores a userAddress supplied in the body', async () => {
    const spoofed = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({ ...BODY, userAddress: owner.publicKey() });

    expect(spoofed.status).toBe(201);
    expect(spoofed.body.subscription.userAddress).toBe(attacker.publicKey());
    expect(rows()[0]!.userAddress).toBe(
      attacker.publicKey(),
    );
  });

  it('lists only the caller’s own subscriptions and never the secret key', async () => {
    await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(BODY);

    const asOwner = await request(app)
      .get('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`);
    const asAttacker = await request(app)
      .get('/v1/webhooks')
      .set('Authorization', `Bearer ${attackerToken}`);

    expect(asOwner.body.subscriptions).toHaveLength(1);
    expect(asAttacker.body.subscriptions).toEqual([]);
    expect(JSON.stringify(asOwner.body)).not.toContain('secretKey');
  });

  const crossTenant: ReadonlyArray<{
    label: string;
    method: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    body?: Record<string, unknown>;
  }> = [
    { label: 'retarget', method: 'patch', path: '/v1/webhooks/wh_1', body: { targetUrl: 'https://evil.example/hook' } },
    { label: 'disable', method: 'delete', path: '/v1/webhooks/wh_1' },
    { label: 're-secret', method: 'post', path: '/v1/webhooks/wh_1/secret' },
    { label: 'read deliveries', method: 'get', path: '/v1/webhooks/wh_1/deliveries' },
    { label: 'fire', method: 'post', path: '/v1/webhooks/wh_1/test' },
  ];

  it.each(crossTenant)('$label another tenant’s subscription is a 404', async ({ method, path, body }) => {
    const created = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(BODY);
    expect(created.status).toBe(201);
    const original = { ...rows()[0]! };

    const attempt = await request(app)[method](path)
      .set('Authorization', `Bearer ${attackerToken}`)
      .send(body ?? {});

    expect(attempt.status).toBe(404);
    expect(attempt.body.error.code).toBe('WEBHOOK_NOT_FOUND');
    // The owner's row is byte-for-byte what it was before the attempt.
    expect(rows()[0]!).toEqual(original);
  });

  it('lets the owner retarget and rotate their own subscription', async () => {
    const created = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(BODY);
    const id = created.body.subscription.id as string;

    const patched = await request(app)
      .patch(`/v1/webhooks/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUrl: 'https://another.example/hook', isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.targetUrl).toBe('https://another.example/hook');
    expect(patched.body.isActive).toBe(false);
    expect(patched.body).not.toHaveProperty('secretKey');

    const rotated = await request(app)
      .post(`/v1/webhooks/${id}/secret`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.body.secretKey).not.toBe(created.body.secretKey);

    const deliveriesList = await request(app)
      .get(`/v1/webhooks/${id}/deliveries`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(deliveriesList.status).toBe(200);
    expect(deliveriesList.body.total).toBe(0);
  });

  it('refuses to store a private target supplied through the route', async () => {
    const response = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...BODY, targetUrl: 'https://169.254.169.254/latest/meta-data/' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('WEBHOOK_URL_INVALID');
    expect(subscriptions).toHaveLength(0);
  });

  it('refuses to retarget onto a private address through the patch route', async () => {
    const created = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(BODY);
    const id = created.body.subscription.id as string;

    const patched = await request(app)
      .patch(`/v1/webhooks/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUrl: 'http://10.0.0.5/hook' });

    expect(patched.status).toBe(400);
    expect(patched.body.error.code).toBe('WEBHOOK_URL_INVALID');
    expect(rows()[0]!.targetUrl).toBe(
      BODY.targetUrl,
    );
  });

  it('makes a single authenticated test dispatch against the stored target', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const created = await request(app)
      .post('/v1/webhooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(BODY);
    const id = created.body.subscription.id as string;

    const tested = await request(app)
      .post(`/v1/webhooks/${id}/test`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(tested.status).toBe(200);
    expect(tested.body.result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BODY.targetUrl);
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-FlowFi-Event']).toBe('webhook.test');
    expect(headers['X-FlowFi-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    vi.unstubAllGlobals();
  });
});
