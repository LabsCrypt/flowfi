const isDev = process.env.NODE_ENV !== "production";

export const logger = {
  debug: (...args: unknown[]) => {
    if (isDev) console.debug(...args); // eslint-disable-line no-console
  },
  info: (...args: unknown[]) => {
    if (isDev) console.info(...args); // eslint-disable-line no-console
  },
  warn: (...args: unknown[]) => {
    if (isDev) console.warn(...args); // eslint-disable-line no-console
  },
  // errors always surface, even in production
  error: (...args: unknown[]) => {
    console.error(...args); // eslint-disable-line no-console
  },
};
