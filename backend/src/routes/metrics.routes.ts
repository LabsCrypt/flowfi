import { Router, type Request, type Response } from 'express';
import net from 'node:net';
import { getMetricsRegistry, metricsContentType } from '../lib/metrics.js';
import logger from '../logger.js';

const router = Router();

/**
 * Access control for the Prometheus scrape endpoint.
 *
 * The endpoint leaks operational detail (ledger lag, pool saturation, RPC
 * health), so it is deny-by-default in production. Two independent guards are
 * supported:
 *
 *  - `METRICS_BEARER_TOKEN` — Prometheus sends `Authorization: Bearer <token>`.
 *  - `METRICS_ALLOWED_CIDRS` — comma-separated IPv4/IPv6 CIDRs the scraper must
 *    originate from (e.g. the internal cluster network).
 *
 * Each guard is skipped when it is not configured, so configuring only one is
 * enough. When *both* are configured a request must satisfy both, which is
 * deliberate defence in depth: a leaked scrape token is then useless from
 * outside the monitoring network. Operators that want either-or should
 * configure a single mechanism.
 *
 * When neither is configured the endpoint is:
 *  - disabled in production (404, so its existence is not advertised), and
 *  - open in development/test so local scrapes just work.
 */
function parseCidrs(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const allowedCidrs = parseCidrs(process.env.METRICS_ALLOWED_CIDRS);
const metricsToken = process.env.METRICS_BEARER_TOKEN;
const isProduction = process.env.NODE_ENV === 'production';

/** True when metrics should answer at all in this environment. */
function metricsEnabled(): boolean {
  if (allowedCidrs.length > 0 || metricsToken) return true;
  return !isProduction;
}

function clientIp(req: Request): string {
  const forwarded = req.socket.remoteAddress ?? '';
  // Strip the IPv4-mapped IPv6 prefix (::ffff:10.0.0.1) that Node reports for
  // dual-stack listeners, otherwise every IPv4 check below would miss.
  return forwarded.startsWith('::ffff:') ? forwarded.slice(7) : forwarded;
}

function isAllowedIp(ip: string): boolean {
  if (allowedCidrs.length === 0) return true;
  if (!ip) return false;

  // BlockList only accepts the address family it was built with, so try the
  // family of the client address rather than guessing.
  const blockList = new net.BlockList();
  for (const cidr of allowedCidrs) {
    const [address, prefix] = cidr.split('/');
    if (!address) continue;
    try {
      if (prefix !== undefined) {
        blockList.addSubnet(address, Number(prefix), ip.includes(':') ? 'ipv6' : 'ipv4');
      } else {
        blockList.addAddress(address, ip.includes(':') ? 'ipv6' : 'ipv4');
      }
    } catch {
      // Ignore malformed CIDRs rather than failing open for the whole endpoint.
    }
  }

  return blockList.check(ip, ip.includes(':') ? 'ipv6' : 'ipv4');
}

function hasValidToken(req: Request): boolean {
  if (!metricsToken) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length).trim() === metricsToken;
}

/**
 * @openapi
 * /metrics:
 *   get:
 *     tags:
 *       - Observability
 *     summary: Prometheus metrics
 *     description: |
 *       Returns the registry in the standard Prometheus exposition format.
 *       Restricted to the internal cluster network (`METRICS_ALLOWED_CIDRS`)
 *       and/or a shared bearer token (`METRICS_BEARER_TOKEN`); when both are
 *       configured the request must satisfy both. Disabled by default in
 *       production when neither is configured.
 *     responses:
 *       200:
 *         description: Metrics in Prometheus text exposition format
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       403:
 *         description: Forbidden - request did not originate from an allowed network or present a valid token
 *       404:
 *         description: Metrics endpoint is disabled in this environment
 */
router.get('/', (req: Request, res: Response) => {
  if (!metricsEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  if (!isAllowedIp(clientIp(req)) || !hasValidToken(req)) {
    res.status(403).json({ error: 'Forbidden', message: 'Metrics access denied' });
    return;
  }

  res.setHeader('Content-Type', metricsContentType);
  getMetricsRegistry()
    .metrics()
    .then((body) => {
      res.status(200).send(body);
    })
    .catch((err: unknown) => {
      logger.error('[Metrics] Failed to render registry:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to render metrics' });
      }
    });
});

export default router;
