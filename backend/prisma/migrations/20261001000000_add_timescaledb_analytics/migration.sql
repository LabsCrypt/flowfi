-- TimescaleDB analytics backbone (#1480).
--
-- Protocol TVL, streaming velocity and withdrawn totals change with every
-- ledger second, so they are snapshotted into a hypertable and pre-aggregated
-- with continuous aggregates instead of being recomputed from the raw Stream
-- and StreamEvent tables on every request.
--
-- Requires the timescaledb extension to be available on the PostgreSQL
-- instance (see docker-compose.yml). If the extension is not installed the
-- statements below fail; the analytics API falls back to live Prisma
-- aggregation in that case, so existing deployments keep working.

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Hypertable for continuous stream flow snapshots. One row per
-- (token_address, snapshot tick) produced by the indexer's aggregation pass.
CREATE TABLE IF NOT EXISTS stream_flow_snapshots (
    time TIMESTAMPTZ NOT NULL,
    token_address TEXT NOT NULL,
    active_stream_count INT NOT NULL,
    total_locked_amount NUMERIC(38, 0) NOT NULL,
    cumulative_streamed_amount NUMERIC(38, 0) NOT NULL,
    cumulative_withdrawn_amount NUMERIC(38, 0) NOT NULL,
    flow_velocity_per_second NUMERIC(38, 0) NOT NULL
);

SELECT create_hypertable('stream_flow_snapshots', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_stream_flow_snapshots_token_time
    ON stream_flow_snapshots (token_address, time DESC);

-- Hourly continuous aggregate: average TVL, summed velocity and peak stream
-- count per token, refreshable incrementally by TimescaleDB policies.
CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_protocol_metrics
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       token_address,
       AVG(total_locked_amount) AS avg_tvl,
       SUM(flow_velocity_per_second) AS aggregate_velocity,
       MAX(active_stream_count) AS peak_streams
FROM stream_flow_snapshots
GROUP BY bucket, token_address
WITH NO DATA;

-- Daily continuous aggregate for 30d/90d/1y historical charts.
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_protocol_metrics
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', time) AS bucket,
       token_address,
       AVG(total_locked_amount) AS avg_tvl,
       SUM(flow_velocity_per_second) AS aggregate_velocity,
       MAX(active_stream_count) AS peak_streams,
       MAX(cumulative_withdrawn_amount) AS cumulative_withdrawn
FROM stream_flow_snapshots
GROUP BY bucket, token_address
WITH NO DATA;

-- Refresh policies: hourly aggregate refreshes shortly after each hour ends,
-- daily aggregate in the small hours. Both retain their full window.
SELECT add_continuous_aggregate_policy('hourly_protocol_metrics',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

SELECT add_continuous_aggregate_policy('daily_protocol_metrics',
    start_offset      => INTERVAL '40 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

-- Compress raw snapshots older than 14 days to keep the hypertable small
-- while retaining every data point for the daily rollups.
ALTER TABLE stream_flow_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'token_address'
);

SELECT add_compression_policy('stream_flow_snapshots', INTERVAL '14 days');
