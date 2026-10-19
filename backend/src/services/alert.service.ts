/**
 * Operational alerting.
 *
 * Critical indexer failures are written to `IndexerDeadLetterEvent`, but a table
 * nobody polls is not an alert. This module pushes an urgent, human-readable
 * message to a chat webhook (`ALERT_WEBHOOK_URL`) the moment an event is
 * dead-lettered, so on-call engineers find out before users report missing
 * stream data.
 *
 * The payload is shaped for the receiver at `ALERT_WEBHOOK_URL`:
 *  - Slack incoming webhooks -> Block Kit (`blocks`),
 *  - Discord webhooks -> rich embeds (`embeds`),
 *  - anything else -> a generic JSON envelope.
 *
 * Every exported sender is failure-proof: a webhook outage, a bad URL or a slow
 * endpoint must never throw into (and therefore crash) the indexer loop.
 */
import logger from '../logger.js';

export type AlertWebhookKind = 'slack' | 'discord' | 'generic';

export interface DeadLetterAlert {
  eventId: string;
  eventType: string;
  ledgerSequence: number;
  txHash: string;
  errorMessage: string;
  /** Full stack trace from the failing handler, when one was captured. */
  errorStack?: string | undefined;
  /** Dead-letter attempt counter (1 on first failure, incrementing on retries). */
  attempts?: number | undefined;
}

/** Configured alert webhook, or `undefined` when alerting is disabled. */
export function getAlertWebhookUrl(): string | undefined {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  return url ? url : undefined;
}

/**
 * Deep link an on-call engineer can click to see (and replay/discard) the
 * quarantined event in the admin dead-letter console.
 */
export function buildTriageUrl(eventId: string): string {
  const base = (
    process.env.ADMIN_DASHBOARD_URL ??
    process.env.FRONTEND_URL ??
    'https://app.flowfi.xyz'
  ).replace(/\/+$/, '');

  return `${base}/admin/indexer/dead-letter?eventId=${encodeURIComponent(eventId)}`;
}

/** Classify a webhook URL so the payload matches the chat provider. */
export function detectWebhookKind(url: string): AlertWebhookKind {
  if (/hooks\.slack\.com/i.test(url)) return 'slack';
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return 'discord';
  return 'generic';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Build the provider-specific JSON body for a dead-letter alert. */
export function buildDeadLetterPayload(
  kind: AlertWebhookKind,
  alert: DeadLetterAlert,
): Record<string, unknown> {
  const triageUrl = buildTriageUrl(alert.eventId);
  const attempts = alert.attempts ?? 1;
  const errorText = truncate(alert.errorMessage, 900);
  const stack = alert.errorStack ? truncate(alert.errorStack, 1200) : undefined;

  if (kind === 'slack') {
    return {
      text: `🚨 Indexer dead-letter: ${alert.eventType} at ledger ${alert.ledgerSequence}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 Indexer dead-letter event', emoji: true },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Event type:*\n${alert.eventType}` },
            { type: 'mrkdwn', text: `*Ledger:*\n${alert.ledgerSequence}` },
            { type: 'mrkdwn', text: `*Tx hash:*\n\`${alert.txHash}\`` },
            { type: 'mrkdwn', text: `*Attempts:*\n${attempts}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Error:*\n\`\`\`${errorText}\`\`\`` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Triage in admin' },
              url: triageUrl,
            },
          ],
        },
      ],
    };
  }

  if (kind === 'discord') {
    return {
      content: `🚨 **Indexer dead-letter** — ${alert.eventType} at ledger ${alert.ledgerSequence}`,
      embeds: [
        {
          title: `Dead-lettered event: ${alert.eventType}`,
          url: triageUrl,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
          fields: [
            { name: 'Ledger', value: String(alert.ledgerSequence), inline: true },
            { name: 'Attempts', value: String(attempts), inline: true },
            { name: 'Event id', value: `\`${truncate(alert.eventId, 100)}\``, inline: false },
            { name: 'Tx hash', value: `\`${truncate(alert.txHash, 100)}\``, inline: false },
            { name: 'Error', value: `\`\`\`${errorText}\`\`\``, inline: false },
            ...(stack ? [{ name: 'Stack', value: `\`\`\`${stack}\`\`\``, inline: false }] : []),
          ],
        },
      ],
    };
  }

  return {
    text: `🚨 Indexer dead-letter: ${alert.eventType} at ledger ${alert.ledgerSequence}`,
    eventId: alert.eventId,
    eventType: alert.eventType,
    ledgerSequence: alert.ledgerSequence,
    txHash: alert.txHash,
    errorMessage: alert.errorMessage,
    errorStack: alert.errorStack,
    attempts,
    triageUrl,
    timestamp: new Date().toISOString(),
  };
}

/**
 * POST the alert to `ALERT_WEBHOOK_URL`.
 *
 * @returns `true` when the webhook accepted the message. Never throws: alerting
 *   is best-effort and must not take down the caller (the indexer loop).
 */
export async function sendDeadLetterAlert(alert: DeadLetterAlert): Promise<boolean> {
  const url = getAlertWebhookUrl();
  if (!url) {
    return false;
  }

  try {
    const payload = buildDeadLetterPayload(detectWebhookKind(url), alert);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn(
        `[Alert] Dead-letter webhook returned HTTP ${response.status} for event ${alert.eventId}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    // Swallow: a failed alert must never crash the indexer loop, and the
    // dead-letter row itself remains the source of truth for triage.
    logger.error(`[Alert] Failed to deliver dead-letter webhook for event ${alert.eventId}:`, err);
    return false;
  }
}
