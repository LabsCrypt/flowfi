import { createLogger, format, transports } from 'winston';
import { requestContext } from './lib/request-context.js';

// Re-exported so callers that already read the request context from the logger
// module (worker correlation ids, SSE controller) keep working unchanged.
export { requestContext };

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
