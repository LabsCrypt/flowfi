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
