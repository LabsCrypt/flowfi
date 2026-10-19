import type { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '../lib/metrics.js';

/**
 * Collapse a concrete path into a low-cardinality route template so a stream of
 * `/v1/streams/1/events`, `/v1/streams/2/events`, … does not explode the
 * `flowfi_http_requests_total` series count.
 *
 * The patterns must NOT carry the `g` flag: `RegExp.prototype.test` on a global
 * regex advances `lastIndex` between calls, so consecutive requests would match
 * on every other invocation and leak the raw UUID/hash into the `route` label —
 * one new series per identifier, which is the cardinality explosion this
 * function exists to prevent.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX_RE = /\b[0-9a-f]{56,}\b/i;
const NUMERIC_RE = /^\d+$/;

export function normalizeRoute(req: Request): string {
  // Express populates `route.path` once a handler has matched, which gives us
  // the router's own pattern (e.g. `/streams/:streamId/events`).
  const routePath = req.route?.path;
  const base = (req.baseUrl ?? '').replace(/^\/+/, '');

  if (typeof routePath === 'string' && routePath !== '/') {
    return `/${[base, routePath.replace(/^\/+/, '')].filter(Boolean).join('/')}`;
  }

  if (Array.isArray(routePath) && routePath.length > 0) {
    // Each array entry carries its own leading slash, so strip them per entry
    // exactly as the single-string branch does — otherwise the label would
    // read `/v1//streams//:id` and split into a different series from the
    // equivalent single-path route.
    const parts = routePath
      .map((part) => part.replace(/^\/+/, ''))
      .filter(Boolean);
    return `/${[base, ...parts].filter(Boolean).join('/')}`;
  }

  const segments = req.path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (NUMERIC_RE.test(segment)) return ':id';
      if (UUID_RE.test(segment)) return ':uuid';
      if (LONG_HEX_RE.test(segment)) return ':hash';
      return segment;
    });

  return `/${segments.join('/')}`;
}

/**
 * Count and time every HTTP request. Mounted before the routers so the status
 * is final by the time the `finish`/`close` hook fires.
 *
 * `GET /metrics` itself is counted like any other route — self-scraping is
 * cheap and the visible scrape rate is a useful liveness signal.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  const record = () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const route = normalizeRoute(req);
    const status = res.statusCode;

    httpRequestsTotal.inc({ method: req.method, route, status: String(status) });
    httpRequestDuration.observe({ method: req.method, route }, seconds);
  };

  res.once('finish', record);
  // `close` also fires when the client aborts mid-response, in which case
  // `finish` never will.
  res.once('close', () => {
    if (!res.writableFinished) record();
  });

  next();
}
