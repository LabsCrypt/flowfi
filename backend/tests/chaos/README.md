# Chaos Engineering & Fault-Injection Suite

Automated resilience verification for FlowFi's distributed components. Instead
of trusting happy-path unit tests, this suite deliberately injects adverse
network conditions (latency, packet loss, connection resets, pool exhaustion)
and asserts that the system degrades gracefully and recovers.

Implements issue **#1477**.

## What is verified

| Assertion | Scenario | Expected behaviour |
| --- | --- | --- |
| 1 — RPC failover | Primary Soroban RPC returns `429` / hangs | `RpcPool` trips the circuit breaker and fails over to the secondary endpoint in `< 500ms` |
| 1 — Circuit recovery | Primary heals after cooldown | Breaker transitions `OPEN → HALF_OPEN → CLOSED` and traffic returns |
| 2 — Dead-letter catch | Malformed RPC response | Event is quarantined to the DLQ without crashing the worker; batch continues |
| 3 — Redis recovery | Redis connection torn down | SSE clients get a reconnect notice and local fanout continues until Redis restarts |

## Test tiers

`resilience.chaos.test.ts` runs two tiers:

1. **Deterministic in-process** (always runs). Uses injected fake RPC servers and
   mocked persistence so there is no Docker or network dependency and **no flaky
   failures**.
2. **Docker/Toxiproxy integration** (`describe.runIf`). Runs only when the chaos
   stack below is reachable, and validates the fault-injection harness itself
   against real Redis/Postgres/RPC proxies. It skips cleanly otherwise.

## Running locally

Requirements: Docker + Docker Compose v2.

```bash
# 1. Start the fault-injection stack
docker compose -f backend/tests/chaos/docker-compose.chaos.yml up -d --wait

# 2. Run the suite
cd backend
npm ci                     # if you have not installed deps yet
TOXIPROXY_URL=http://127.0.0.1:8474 \
  npx vitest run tests/chaos/resilience.chaos.test.ts

# 3. Tear down
docker compose -f backend/tests/chaos/docker-compose.chaos.yml down -v
```

You can also run the whole Vitest suite (`npm test`); the chaos file will simply
skip its Docker tier when the stack is not running.

## Fault scenarios

`helpers/toxiproxy.ts` exposes the scenarios named in the issue:

| Scenario | Toxic | Helper |
| --- | --- | --- |
| `soroban_rpc_latency` | 2,000ms latency, 10% jitter | `latencyToxic()` |
| `soroban_rpc_timeout` | drop connection after N bytes | `dropAfterBytesToxic(100)` |
| `redis_kill_reconnect` | reset Redis peer mid-fanout | `redisKillToxic()` |
| `postgres_max_connections` | hold connections to exhaust pool | `postgresHoldToxic()` |
| `soroban_rpc_rate_limit` | synthetic HTTP 429 | `helpers/faulty-rpc-server.ts` (`mode: 'rate-limit'`) |

Toxiproxy operates at the transport layer and cannot synthesise HTTP status
codes, so the `429` rate-limit scenario is injected by the in-process
`faulty-rpc-server.ts` helper. Both paths are exercised by the suite.

## Architecture

```
tests/chaos/
├── docker-compose.chaos.yml     # ephemeral Toxiproxy + deps stack
├── toxiproxy.json               # proxy topology loaded by the stack
├── helpers/
│   ├── toxiproxy.ts             # control-plane client + toxic factories
│   └── faulty-rpc-server.ts     # in-process controllable JSON-RPC stub
└── resilience.chaos.test.ts     # the chaos assertions
```

### Proxied endpoints

| Proxy | Listen (host) | Upstream |
| --- | --- | --- |
| `soroban_rpc` | `127.0.0.1:18000` | `mock-soroban-rpc:8000` |
| `redis` | `127.0.0.1:16379` | `redis:6379` |
| `postgres` | `127.0.0.1:15432` | `postgres:5432` |

Toxiproxy control API: `http://127.0.0.1:8474`.

## CI

`.github/workflows/chaos-testing.yml` runs the suite nightly, on release
candidates, and on pull requests touching the backend/chaos paths. It brings up
the stack with `--wait`, runs the tests, and dumps container logs on failure.
