/**
 * Delivery-time SSRF validation (issue #1849).
 *
 * Registration already refuses private targets, but that is only half the
 * guard: between the PATCH of a subscription and the moment a worker opens the
 * socket, an authoritative name can be re-pointed at `169.254.169.254`. These
 * tests keep the real validator in the path and replace only the resolver, so
 * each case says what the delivery loop does when DNS answers differently than
 * it did at registration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dns, state, prismaFake } = vi.hoisted(() => {
  const dns = { addresses: ['93.184.216.34'] as string[] };
  const state = {
    subscriptions: [] as Record<string, unknown>[],
    deliveries: [] as Record<string, unknown>[],
  };
  const prismaFake = {
    webhookSubscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `wh_${state.subscriptions.length + 1}`, isActive: true, ...data };
        state.subscriptions.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.subscriptions.find(
          (row) =>
            row.id === where.id &&
            row.userAddress === where.userAddress &&
            (where.isActive === undefined || row.isActive === where.isActive),
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(state.subscriptions.find((row) => row.id === where.id) ?? {}, data),
    },
    webhookDelivery: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `dl_${state.deliveries.length + 1}`,
          attempts: 0,
          responseStatus: null,
          deliveredAt: null,
          error: null,
          ...data,
        };
        state.deliveries.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(state.deliveries.find((row) => row.id === where.id) ?? {}, data),
      findMany: async () => [],
      count: async () => 0,
    },
  };
  return { dns, state, prismaFake };
});

vi.mock('node:dns/promises', () => ({
  lookup: async () => dns.addresses.map((address) => ({ address, family: 0 })),
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaFake }));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createWebhookSubscription,
  deliverWebhook,
  sendTestWebhook,
} from '../src/services/webhook.service.js';

const PUBLIC = '93.184.216.34';
const SUBSCRIPTION = {
  id: 'wh_1',
  userAddress: 'G-OWNER',
  targetUrl: 'https://receiver.example/hook',
  secretKey: 'super-secret',
  eventTypes: ['STREAM_CREATED'],
  isActive: true,
};
const PAYLOAD = {
  eventType: 'STREAM_CREATED',
  data: { streamId: '1' },
  timestamp: '2026-11-01T12:00:00.000Z',
};

function currentDelivery(): Record<string, unknown> {
  return state.deliveries[0] as Record<string, unknown>;
}

describe('#1849 delivery re-validates the resolved address', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    state.subscriptions.length = 0;
    state.deliveries.length = 0;
    dns.addresses = [PUBLIC];
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ status: 200 });
  });

  const privateAtDelivery = [
    { address: '169.254.169.254', label: 'cloud metadata (link-local)' },
    { address: '127.0.0.1', label: 'loopback' },
    { address: '10.255.255.255', label: 'RFC1918' },
    { address: '192.168.1.1', label: 'home router' },
    { address: '100.64.0.1', label: 'CGNAT' },
    { address: '::1', label: 'IPv6 loopback' },
    { address: 'fd00::1', label: 'IPv6 unique local' },
  ];

  it.each(privateAtDelivery)('does not fetch when DNS answers $label ($address)', async ({
    address,
  }) => {
    dns.addresses = [address];

    const result = await deliverWebhook(SUBSCRIPTION, PAYLOAD, { retries: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(currentDelivery().error).toContain('blocked');
  });

  it('does not fetch when the name stops resolving entirely', async () => {
    dns.addresses = [];

    const result = await deliverWebhook(SUBSCRIPTION, PAYLOAD, { retries: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(currentDelivery().error).toContain('does not resolve');
  });

  it('still fetches a public answer — the guard is not a blanket block', async () => {
    const result = await deliverWebhook(SUBSCRIPTION, PAYLOAD, { retries: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, status: 200 });
    expect(currentDelivery().deliveredAt).not.toBeNull();
  });

  it('blocks a DNS-rebinding target that validated at registration', async () => {
    dns.addresses = [PUBLIC];
    const created = await createWebhookSubscription(
      'G-OWNER',
      'https://receiver.example/hook',
      ['STREAM_CREATED'],
    );
    expect(created.targetUrl).toBe('https://receiver.example/hook');

    // The attacker now moves the record; the stored subscription is unchanged.
    dns.addresses = ['169.254.169.254'];
    const result = await deliverWebhook(created, PAYLOAD, { retries: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('spends no retry attempts on a blocked target', async () => {
    dns.addresses = ['127.0.0.1'];

    const result = await deliverWebhook(SUBSCRIPTION, PAYLOAD);

    // The ladder would otherwise re-open the same hole five more times.
    expect(currentDelivery().attempts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('refuses a test dispatch to a target that became private', async () => {
    dns.addresses = [PUBLIC];
    await createWebhookSubscription('G-OWNER', SUBSCRIPTION.targetUrl, ['*']);

    dns.addresses = ['10.0.0.1'];
    const result = await sendTestWebhook('wh_1', 'G-OWNER');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('never follows a redirect, so a public host cannot bounce into a blocked range', async () => {
    dns.addresses = [PUBLIC];
    fetchMock.mockResolvedValue({ status: 302, headers: { location: 'https://169.254.169.254/' } });

    const result = await deliverWebhook(SUBSCRIPTION, PAYLOAD, { retries: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(result).toEqual({ success: false, status: 302, error: 'HTTP 302' });
  });
});
