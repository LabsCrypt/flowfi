import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  buildDeadLetterPayload,
  buildTriageUrl,
  detectWebhookKind,
  getAlertWebhookUrl,
  sendDeadLetterAlert,
  type DeadLetterAlert,
} from '../src/services/alert.service.js';

const ALERT: DeadLetterAlert = {
  eventId: 'event-0001',
  eventType: 'stream_created',
  ledgerSequence: 482910,
  txHash: 'abc123',
  errorMessage: 'StreamCreated #7: missing body fields',
  errorStack: 'Error: boom\n  at handler (worker.ts:1:1)',
  attempts: 5,
};

describe('alert webhook configuration', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['ALERT_WEBHOOK_URL', 'ADMIN_DASHBOARD_URL', 'FRONTEND_URL'] as const;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
  });

  it('returns undefined when ALERT_WEBHOOK_URL is unset or blank', () => {
    expect(getAlertWebhookUrl()).toBeUndefined();
    process.env.ALERT_WEBHOOK_URL = '   ';
    expect(getAlertWebhookUrl()).toBeUndefined();
  });

  it('trims a configured webhook URL', () => {
    process.env.ALERT_WEBHOOK_URL = '  https://hooks.slack.com/services/x  ';
    expect(getAlertWebhookUrl()).toBe('https://hooks.slack.com/services/x');
  });

  it('detects the provider from the webhook URL', () => {
    expect(detectWebhookKind('https://hooks.slack.com/services/x')).toBe('slack');
    expect(detectWebhookKind('https://discord.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectWebhookKind('https://discordapp.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectWebhookKind('https://alerts.example.com/hook')).toBe('generic');
  });

  it('builds a triage deep link and honours ADMIN_DASHBOARD_URL', () => {
    expect(buildTriageUrl('evt 1')).toContain('/admin/indexer/dead-letter?eventId=evt%201');
    process.env.ADMIN_DASHBOARD_URL = 'https://ops.flowfi.xyz/';
    expect(buildTriageUrl('evt-1')).toBe(
      'https://ops.flowfi.xyz/admin/indexer/dead-letter?eventId=evt-1',
    );
  });
});

describe('dead-letter payload formatting', () => {
  it('builds Slack Block Kit with ledger, tx hash, error and triage action', () => {
    const payload = buildDeadLetterPayload('slack', ALERT) as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string }; elements?: unknown[] }>;
    };

    expect(payload.text).toContain('stream_created');
    expect(payload.blocks[0]!.type).toBe('header');
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('482910');
    expect(serialized).toContain('abc123');
    expect(serialized).toContain('missing body fields');
    expect(payload.blocks.some((b) => b.type === 'actions')).toBe(true);
  });

  it('builds a Discord embed with rich fields', () => {
    const payload = buildDeadLetterPayload('discord', ALERT) as {
      content: string;
      embeds: Array<{ fields: Array<{ name: string; value: string }>; color: number }>;
    };

    expect(payload.content).toContain('Indexer dead-letter');
    expect(payload.embeds).toHaveLength(1);
    const names = payload.embeds[0]!.fields.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['Ledger', 'Attempts', 'Tx hash', 'Error', 'Stack']),
    );
  });

  it('builds a generic JSON envelope for unknown receivers', () => {
    const payload = buildDeadLetterPayload('generic', ALERT);
    expect(payload).toMatchObject({
      eventId: 'event-0001',
      eventType: 'stream_created',
      ledgerSequence: 482910,
      txHash: 'abc123',
      attempts: 5,
    });
    expect(typeof payload.triageUrl).toBe('string');
  });
});

describe('sendDeadLetterAlert', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['ALERT_WEBHOOK_URL'] = process.env.ALERT_WEBHOOK_URL;
  });

  afterEach(() => {
    if (saved['ALERT_WEBHOOK_URL'] === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = saved['ALERT_WEBHOOK_URL'];
    vi.unstubAllGlobals();
  });

  it('is a no-op when alerting is not configured', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the formatted payload to the configured webhook', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/x';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.com/services/x');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.blocks).toBeDefined();
  });

  it('returns false on a non-2xx response without throwing', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(false);
  });

  it('swallows network errors so the indexer loop is never crashed', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.com/hook';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(sendDeadLetterAlert(ALERT)).resolves.toBe(false);
  });
});
