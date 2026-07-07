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

export default logger;

/** Structured audit entry for security-sensitive actions (no secrets/tokens). */
export function auditLog(
  actor: string,
  action: string,
  params: Record<string, unknown> = {},
): void {
  const ctx = requestContext.getStore();
  logger.info('audit', {
    audit: true,
    actor,
    action,
    params,
    requestId: ctx?.requestId,
  });
}
