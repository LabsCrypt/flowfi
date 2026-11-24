import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus instrumentation for the FlowFi backend.
 *
 * Everything in this module is a no-op-safe singleton: importing it never
 * throws and never opens a socket, so it is safe to pull in from the worker,
 * the SSE service, and the HTTP layer alike. The registry is exposed via
 * `getMetricsRegistry()` and rendered by `GET /metrics`.
 *
 * Metric names are prefixed with `flowfi_` so a shared Prometheus instance can
 * scrape several services without collisions.
 */

/** Default histogram buckets — tuned for both sub-millisecond DB hits and slow RPC calls. */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const registry = new Registry();

/** Reserved `topic` label value carrying the aggregate connection count. */
export const TOTAL_SSE_TOPIC = 'total';

collectDefaultMetrics({
  register: registry,
  prefix: 'flowfi_process_',
});

// ─── Indexer lag ─────────────────────────────────────────────────────────────

/** Last ledger successfully written by the indexer. */
export const indexerCurrentLedger = new Gauge({
  name: 'flowfi_indexer_current_ledger',
  help: 'Last ledger sequence fully indexed by the Soroban event worker',
  registers: [registry],
});

/** Most recent ledger sequence observed on the network. */
export const indexerNetworkLedger = new Gauge({
  name: 'flowfi_indexer_network_ledger',
  help: 'Latest ledger sequence reported by the Stellar network',
  registers: [registry],
});

/** network - current. Kept as its own gauge so alerts do not need arithmetic. */
export const indexerLagLedgers = new Gauge({
  name: 'flowfi_indexer_lag_ledgers',
  help: 'Number of ledgers the indexer is behind the network tip',
  registers: [registry],
});

export const indexerPollsTotal = new Counter({
  name: 'flowfi_indexer_polls_total',
  help: 'Indexer poll cycles by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const indexerEventsProcessedTotal = new Counter({
  name: 'flowfi_indexer_events_processed_total',
  help: 'Contract events dispatched by the indexer worker by result',
  labelNames: ['eventType', 'result'] as const,
  registers: [registry],
});

/**
 * Ledger reorg / fork recoveries. Incremented once per recovery so a sustained
 * non-zero rate (or a single spike) can page an operator: on Stellar a reorg
 * means either an RPC node served us a stale fork or the indexer is desynced,
 * both of which need human review even when the rollback itself succeeded.
 */
export const indexerReorgEventsTotal = new Counter({
  name: 'flowfi_indexer_reorg_events_total',
  help: 'Ledger reorg / fork recoveries triggered by the indexer, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** Ledgers above the last verified checkpoint that the most recent rollback reverted. */
export const indexerRevertedLedgers = new Gauge({
  name: 'flowfi_indexer_reverted_ledgers',
  help: 'Ledger count reverted by the most recent indexer rollback',
  registers: [registry],
});

// ─── SSE ─────────────────────────────────────────────────────────────────────

/**
 * Live SSE clients. Labelled by topic so operators can see saturation of the
 * `admin` fan-out separately from per-stream subscriptions.
 */
export const sseActiveConnections = new Gauge({
  name: 'flowfi_sse_active_connections',
  help: 'Currently connected SSE clients by subscription topic',
  labelNames: ['topic'] as const,
  registers: [registry],
});

export const sseConnectionsTotal = new Counter({
  name: 'flowfi_sse_connections_total',
  help: 'SSE client connections accepted since process start',
  registers: [registry],
});

export const sseClientsDroppedTotal = new Counter({
  name: 'flowfi_sse_clients_dropped_total',
  help: 'SSE clients dropped for backpressure, capacity, or per-IP limits',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Mirror of the service's hard connection ceiling, for saturation ratios. */
export const sseMaxConnections = new Gauge({
  name: 'flowfi_sse_max_connections',
  help: 'Configured maximum number of concurrent SSE connections',
  registers: [registry],
});

// ─── Soroban RPC ─────────────────────────────────────────────────────────────

/** Wall-clock latency of every outbound Soroban RPC call, by method. */
export const rpcRequestDuration = new Histogram({
  name: 'flowfi_rpc_request_duration_seconds',
  help: 'Duration of outbound Stellar RPC requests by method',
  labelNames: ['method'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

export const rpcRequestsTotal = new Counter({
  name: 'flowfi_rpc_requests_total',
  help: 'Outbound Stellar RPC requests by method and outcome',
  labelNames: ['method', 'outcome'] as const,
  registers: [registry],
});

/**
 * Failover events. Today the pool points at a single endpoint
 * (`SOROBAN_RPC_URL`), so a failover is recorded for each retry attempt issued
 * by `withRpcRetry`. When multi-RPC rotation lands, add a `to` label to name the
 * endpoint actually promoted.
 */
export const rpcFailoversTotal = new Counter({
  name: 'flowfi_rpc_failovers_total',
  help: 'RPC failover events (retries issued after a failed attempt)',
  labelNames: ['method'] as const,
  registers: [registry],
});

/**
 * Circuit-breaker trips. A call that exhausts its retry budget — or hits the
 * hard RPC deadline — is treated as a trip, since those are the conditions a
 * breaker would latch on.
 */
export const rpcCircuitBreakerTripsTotal = new Counter({
  name: 'flowfi_rpc_circuit_breaker_trips_total',
  help: 'RPC circuit-breaker trips by endpoint and method',
  labelNames: ['endpoint', 'method'] as const,
  registers: [registry],
});

// ─── Database ────────────────────────────────────────────────────────────────

/** Duration of Prisma operations, by model-level operation name. */
export const dbQueryDuration = new Histogram({
  name: 'flowfi_db_query_duration_seconds',
  help: 'Duration of Prisma database operations',
  labelNames: ['operation'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

export const dbPoolConnections = new Gauge({
  name: 'flowfi_db_pool_connections',
  help: 'PostgreSQL connection pool utilisation',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const dbPoolMaxConnections = new Gauge({
  name: 'flowfi_db_pool_max_connections',
  help: 'Configured maximum size of the PostgreSQL connection pool',
  registers: [registry],
});

/**
 * Point-in-time sample of the pg pool. Supplied by `pg-pool.ts` via
 * `registerDbPoolStatsProvider` so this module never imports `pg` (importing
 * metrics from the worker must not open a database connection).
 */
export interface DbPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

let dbPoolStatsProvider: (() => DbPoolStats) | null = null;

/**
 * Attach the pool whose `totalCount`/`idleCount`/`waitingCount` the gauges
 * below should read. Called once from `createPgPool`.
 */
export function registerDbPoolStatsProvider(provider: () => DbPoolStats): void {
  dbPoolStatsProvider = provider;
}

/**
 * Read the current pool counts, tolerating a missing or throwing provider so a
 * broken pool can never make the whole `/metrics` scrape fail.
 */
function sampleDbPool(): DbPoolStats {
  try {
    return dbPoolStatsProvider?.() ?? { total: 0, idle: 0, waiting: 0 };
  } catch {
    return { total: 0, idle: 0, waiting: 0 };
  }
}

/**
 * Connection pool gauges. `waiting` is the one to alert on: a non-zero value
 * means callers are queued for a connection, which shows up as request latency
 * long before the pool is technically exhausted.
 *
 * Each gauge samples the pool via `collect()` on every scrape rather than being
 * pushed on a timer, so a scrape always reflects the pool at that instant.
 */
export const dbPoolTotalConnections = new Gauge({
  name: 'flowfi_db_pool_total_connections',
  help: 'Total PostgreSQL connections currently held by the pool',
  registers: [registry],
  collect() {
    this.set(sampleDbPool().total);
  },
});

export const dbPoolIdleConnections = new Gauge({
  name: 'flowfi_db_pool_idle_connections',
  help: 'Idle PostgreSQL connections available in the pool',
  registers: [registry],
  collect() {
    this.set(sampleDbPool().idle);
  },
});

export const dbPoolWaitingRequests = new Gauge({
  name: 'flowfi_db_pool_waiting_requests',
  help: 'Requests queued waiting for a PostgreSQL connection',
  registers: [registry],
  collect() {
    this.set(sampleDbPool().waiting);
  },
});

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** Every API request, labelled by low-cardinality route template and status. */
export const httpRequestsTotal = new Counter({
  name: 'flowfi_http_requests_total',
  help: 'HTTP API requests by status code and route',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'flowfi_http_request_duration_seconds',
  help: 'HTTP API request duration by route',
  labelNames: ['method', 'route'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

// ─── Sentinel anomaly detection (Issue #1469) ────────────────────────────────

/** Anomaly incidents raised by the drain sentinel, by rule and severity. */
export const sentinelIncidentsTotal = new Counter({
  name: 'flowfi_sentinel_incidents_total',
  help: 'Anomaly incidents raised by the stream drain sentinel',
  labelNames: ['ruleId', 'severity'] as const,
  registers: [registry],
});

/** Outbound alert deliveries fanned out by the sentinel, by channel + outcome. */
export const sentinelAlertsDispatchedTotal = new Counter({
  name: 'flowfi_sentinel_alerts_dispatched_total',
  help: 'Sentinel alert deliveries by channel and outcome',
  labelNames: ['channel', 'outcome'] as const,
  registers: [registry],
});

/** Aggregate threat score (0-100) derived from recently retained incidents. */
export const sentinelThreatScore = new Gauge({
  name: 'flowfi_sentinel_threat_score',
  help: 'Aggregate anomaly threat score (0-100) over the retention window',
  registers: [registry],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recompute the lag gauge. `networkLedger` may be 0 when the RPC tip could not
 * be resolved; in that case the previous lag value is cleared rather than
 * reported as a bogus full-network lag.
 */
/** Record a completed rollback for alerting; 0 clears the gauge after a clean run. */
export function setIndexerRevertedLedgers(count: number): void {
  indexerRevertedLedgers.set(count);
}

export function setIndexerLedgers(currentLedger: number, networkLedger: number): void {
  indexerCurrentLedger.set(currentLedger);
  indexerNetworkLedger.set(networkLedger);

  if (networkLedger > 0) {
    indexerLagLedgers.set(Math.max(0, networkLedger - currentLedger));
  } else {
    indexerLagLedgers.set(0);
  }
}

/**
 * Reset every per-topic SSE gauge, then re-publish the supplied counts.
 *
 * The aggregate is published under the reserved `topic="total"` label so
 * `sum(flowfi_sse_active_connections)` stays meaningful on an idle instance
 * instead of returning "no data". Dashboards must exclude that label when they
 * want the per-topic breakdown.
 */
export function setSseConnectionCounts(countsByTopic: Map<string, number>, total: number): void {
  sseActiveConnections.reset();
  for (const [topic, count] of countsByTopic) {
    sseActiveConnections.set({ topic }, count);
  }
  sseActiveConnections.set({ topic: TOTAL_SSE_TOPIC }, total);
}

/** Record a single outbound RPC call. `outcome` is success | error | timeout. */
export function recordRpcRequest(method: string, seconds: number, outcome: string): void {
  rpcRequestDuration.observe({ method }, seconds);
  rpcRequestsTotal.inc({ method, outcome });
}

/** Publish the latest sentinel threat score for alerting dashboards. */
export function setSentinelThreatScore(score: number): void {
  sentinelThreatScore.set(score);
}

export function getMetricsRegistry(): Registry {
  return registry;
}

export const metricsContentType = registry.contentType;
