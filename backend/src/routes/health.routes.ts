import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { setIndexerLedgers } from '../lib/metrics.js';
import { getPublisher } from '../lib/redis.js';
import { TimeoutError, withTimeout } from '../lib/with-timeout.js';
import { checkRpcHealth, getLatestLedger } from '../services/sorobanService.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger from '../logger.js';

const router = Router();

interface CachedHealth {
  status: number;
  body: unknown;
  expiresAt: number;
}
let _healthCache: CachedHealth | null = null;
// 2s cache (issue #1511). Disabled under NODE_ENV=test unless HEALTH_CACHE_MS is set.
const HEALTH_CACHE_MS = Number(
  process.env.HEALTH_CACHE_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2_000),
);

/** Clears the cached health result (used by tests). */
export function resetHealthCache(): void {
  _healthCache = null;
}

/**
 * Upper bound for each dependency probe. Probes run in parallel, so the whole
 * response takes roughly this long in the worst case. Kept below 1,000 ms to
 * leave headroom for request handling and JSON serialisation (Issue #1492).
 */
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 800;

function getHealthcheckTimeoutMs(): number {
  const parsed = Number(process.env.HEALTHCHECK_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HEALTHCHECK_TIMEOUT_MS;
}

type DatabaseStatus = 'ok' | 'down' | 'timeout';
type RedisStatus = 'ok' | 'unavailable' | 'timeout' | 'not_configured';
type IndexerState = Awaited<ReturnType<typeof prisma.indexerState.findUnique>>;

// Last reported status per component, so failures are logged once when they
// start (and once on recovery) instead of on every probe.
const lastStatus = new Map<string, string>();

function reportStatus(component: string, status: string, healthy: boolean): void {
  const previous = lastStatus.get(component);
  lastStatus.set(component, status);
  if (previous === status || (previous === undefined && healthy)) return;

  if (healthy) {
    logger.info(`[Health] ${component} recovered`, { status, previous });
  } else {
    logger.warn(`[Health] ${component} check failing`, { status, previous: previous ?? null });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkDatabase(timeoutMs: number): Promise<DatabaseStatus> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs, 'database ping');
    return 'ok';
  } catch (err) {
    logger.debug('[Health] database ping failed', { error: errorMessage(err) });
    return err instanceof TimeoutError ? 'timeout' : 'down';
  }
}

async function checkRedis(timeoutMs: number): Promise<RedisStatus> {
  // Redis is optional: without REDIS_URL the SSE layer runs in single-instance mode.
  if (!process.env.REDIS_URL) return 'not_configured';

  // Fast path: a client that is not connected cannot answer, so don't wait on it.
  const client = getPublisher();
  if (!client || client.status !== 'ready') return 'unavailable';

  try {
    await withTimeout(client.ping(), timeoutMs, 'redis ping');
    return 'ok';
  } catch (err) {
    logger.debug('[Health] redis ping failed', { error: errorMessage(err) });
    return err instanceof TimeoutError ? 'timeout' : 'unavailable';
  }
}

async function readIndexerState(timeoutMs: number): Promise<IndexerState> {
  try {
    return await withTimeout(
      prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } }),
      timeoutMs,
      'indexer state lookup',
    );
  } catch {
    return null;
  }
}

async function checkSorobanRpc(timeoutMs: number): Promise<boolean> {
  try {
    return await withTimeout(checkRpcHealth(timeoutMs), timeoutMs, 'soroban rpc health');
  } catch {
    return false;
  }
}

async function readNetworkLedger(timeoutMs: number): Promise<number> {
  try {
    return await withTimeout(getLatestLedger(), timeoutMs, 'latest ledger lookup');
  } catch {
    return 0;
  }
}

/**
 * @openapi
 * /health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Detailed health check
 *     description: |
 *       Returns liveness and readiness information.
 *       **Liveness** (200 vs 503) is determined by DB reachability alone.
 *       **Indexer lag** is reported in the body for observability but only
 *       forces a 503 when the indexer is actually enabled
 *       (`STREAM_CONTRACT_ID` env var set) and its state row is stale
 *       (lag > 60 s). A cold-started instance with no state row yet, or a
 *       deployment with the indexer intentionally disabled, always returns 200
 *       as long as the DB is reachable.
 *       **Event-processing failures** are also reported. When the indexer is
 *       enabled and recent per-event failures spike (≥50% of attempts in the
 *       last 5 minutes, with ≥3 samples), the endpoint returns 503 even if
 *       lag looks healthy (the IndexerState upsert bumps updatedAt every poll).
 *       **Redis** is optional. When it is configured but unavailable or does not
 *       answer a ping in time, `status` is `degraded` but the response stays
 *       200, so a Redis outage does not fail liveness probes.
 *       Every dependency probe runs in parallel and is bounded by
 *       `HEALTHCHECK_TIMEOUT_MS` (default 800 ms), so the endpoint answers in
 *       under a second even when a dependency hangs.
 *       The response is cached in-memory for 2 s so consecutive rapid requests
 *       do not re-run the probes (issue #1511).
 *     responses:
 *       200:
 *         description: Service is healthy (Redis may still be degraded)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       503:
 *         description: Service is degraded or unhealthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       429:
 *         description: Rate limited
 */
router.get('/', async (_req: Request, res: Response) => {
  if (_healthCache && _healthCache.expiresAt > Date.now()) {
    res.set('Cache-Control', 'no-store');
    res.status(_healthCache.status).json(_healthCache.body);
    return;
  }

  const timeoutMs = getHealthcheckTimeoutMs();

  // Whether the event-indexer is configured (STREAM_CONTRACT_ID must be set for it to run).
  const indexerEnabled = !!process.env.STREAM_CONTRACT_ID;

  // Probes are independent, so run them together: total time is bounded by
  // the slowest probe (at most timeoutMs), not the sum. None of them reject.
  const [database, state, redisStatus, sorobanRpcOk, networkLedger] = await Promise.all([
    checkDatabase(timeoutMs),
    readIndexerState(timeoutMs),
    checkRedis(timeoutMs),
    checkSorobanRpc(timeoutMs),
    // Resolve the network tip so ledger lag is reportable without waiting for
    // the next indexer poll. Failure is non-fatal: lag degrades to null.
    indexerEnabled ? readNetworkLedger(timeoutMs) : Promise.resolve(0),
  ]);

  const dbStatus = database === 'ok' ? 'connected' : 'disconnected';

  // indexerLag === -1 means no state row yet (cold start) — not an error.
  const indexerLag = state
    ? Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(state.updatedAt.getTime() / 1000))
    : -1;

  const eventCounters = sorobanEventWorker.getEventCounters();

  // 503 when: DB is down, OR the indexer is enabled and its state row is
  // stale (lag > 60), OR recent event-processing failures are spiking.
  // A missing state row (lag === -1) is a cold-start condition, not a failure,
  // even when the indexer is enabled.
  const indexerLagDegraded = indexerEnabled && indexerLag > 60;
  const indexerFailureDegraded = indexerEnabled && eventCounters.degraded;
  const isHealthy = database === 'ok' && !indexerLagDegraded && !indexerFailureDegraded;

  // Redis never affects the HTTP status (it is optional, and failing liveness
  // on a Redis outage would restart every instance), but a configured Redis
  // that is down or unresponsive is surfaced as a degraded status.
  const redisDegraded = redisStatus === 'unavailable' || redisStatus === 'timeout';
  const status = isHealthy && !redisDegraded ? 'ok' : 'degraded';

  reportStatus('database', database, database === 'ok');
  reportStatus('redis', redisStatus, !redisDegraded);

  // Keep the Prometheus gauges in step with what /health reports, so a scrape
  // taken between poll cycles still reflects the ledger the indexer reached.
  setIndexerLedgers(state?.lastLedger ?? 0, networkLedger);

  const responseBody = {
    status,
    db: dbStatus,
    redis: redisStatus,
    indexerEnabled,
    indexerLag: indexerLag === -1 ? null : indexerLag,
    // Ledger-level lag, which is what `flowfi_indexer_lag_ledgers` tracks.
    // Null when the network tip could not be resolved.
    indexerLedgerLag:
      networkLedger > 0 ? Math.max(0, networkLedger - (state?.lastLedger ?? 0)) : null,
    eventsProcessed: eventCounters.eventsProcessed,
    eventsFailed: eventCounters.eventsFailed,
    lastErrorAt: eventCounters.lastErrorAt,
    indexerDegraded: eventCounters.degraded,
    uptime: process.uptime(),
    checks: {
      database: {
        status: database,
      },
      indexer: {
        status: !indexerEnabled ? 'disabled' : indexerFailureDegraded || indexerLagDegraded ? 'degraded' : 'ok',
        enabled: indexerEnabled,
        lagSeconds: indexerLag === -1 ? null : indexerLag,
      },
      redis: {
        status: redisStatus,
      },
      sorobanRpc: {
        status: sorobanRpcOk ? 'ok' : 'down',
      },
    },
  };

  const httpStatus = isHealthy ? 200 : 503;
  if (HEALTH_CACHE_MS > 0) {
    _healthCache = { status: httpStatus, body: responseBody, expiresAt: Date.now() + HEALTH_CACHE_MS };
  }
  res.set('Cache-Control', 'no-store');
  res.status(httpStatus).json(responseBody);
});

export default router;
