import { AsyncLocalStorage } from 'async_hooks';
import { createLogger, format, transports } from 'winston';

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format((info) => {
      const ctx = requestContext.getStore();
      if (ctx?.requestId) info.requestId = ctx.requestId;
      return info;
    })(),
    format.json(),
  ),
  transports: [new transports.Console()],
});

/** A value an audit entry is allowed to carry. */
export type AuditValue = string | number | boolean | null;

/**
 * Keys an audit entry refuses to carry.
 *
 * The logger itself writes metadata verbatim — see the "gap" block in
 * `tests/logger-redaction-contract.test.ts` — so the guarantee that audit
 * entries are secret-free has to come from the entry's construction, not from
 * a downstream filter. A key that names a credential never reaches the wire,
 * even if a caller passes one by mistake.
 */
const SECRET_KEY =
  /pass(word|phrase)?|secret|token|authorization|credential|private|seed|signature|api[-_]?key|mnemonic/i;

function auditSafe(params: Record<string, unknown>): Record<string, AuditValue> {
  const safe: Record<string, AuditValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (SECRET_KEY.test(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safe[key] = value as AuditValue;
    } else if (typeof value === 'bigint') {
      safe[key] = value.toString();
    }
  }
  return safe;
}

/**
 * Record who did a privileged thing, what they did, and with which parameters.
 *
 * Emits one `info` record with `message: "audit: <action>"` and an `audit`
 * object holding `action`, `actor` and `params`. The surrounding
 * `requestContext` adds `requestId` to the same record, so the entry can be
 * joined to the request that produced it. `params` is filtered by
 * {@link auditSafe}: secret-shaped keys and non-primitive values are dropped
 * rather than serialized.
 */
export function auditLog(
  action: string,
  actor: string,
  params: Record<string, unknown> = {},
): void {
  logger.info(`audit: ${action}`, {
    audit: { action, actor, params: auditSafe(params) },
  });
}

export default logger;
