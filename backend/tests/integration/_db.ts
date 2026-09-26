/**
 * Shared helper for integration tests that require a real Postgres
 * database (e.g. stream-lifecycle.test.ts).
 *
 * Behavior:
 *   - resolveDbReadiness() returns true if DATABASE_URL is set AND the
 *     server is reachable within a short timeout, false otherwise.
 *   - explainSkipReason() returns a human-readable reason describing why
 *     the integration test suite was skipped.
 *
 * Why this exists (issue #760):
 *   On default branch, running `npm test` from a clean checkout fails
 *   because the postgres service used by stream-lifecycle.test.ts is not
 *   available. By probing here and skipping cleanly, unit tests and
 *   mocked integration tests still run while real-DB integration tests
 *   report a clear, actionable log message instead of crashing.
 */
import { Client } from "pg";

export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:password@127.0.0.1:5432/flowfi_test";

const PROBE_TIMEOUT_MS = 2_000;

export function resolveTestDatabaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

export interface DbReadiness {
  ready: boolean;
  reason: string;
  url: string | null;
}

export async function resolveDbReadiness(): Promise<DbReadiness> {
  const url = resolveTestDatabaseUrl();

  if (!process.env.DATABASE_URL) {
    return {
      ready: false,
      reason:
        "DATABASE_URL is not set. Integration tests that require a real Postgres server will be skipped. " +
        "Run `docker compose up -d postgres` or set DATABASE_URL to enable them.",
      url,
    };
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ready: true, reason: "ok", url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      reason: `Database probe failed for DATABASE_URL=${url}: ${message}`,
      url,
    };
  } finally {
    // Always release the probe connection so a half-broken Postgres
    // does not leak sockets between runs.
    await client.end().catch(() => undefined);
  }
}

export function explainSkipReason(readiness: DbReadiness): string {
  if (readiness.ready) return "";
  return [
    "[integration] Skipping real-DB integration suite:",
    `  ${readiness.reason}`,
    "  To run these tests locally:",
    "    1. docker compose up -d postgres",
    "    2. export DATABASE_URL=postgresql://flowfi:flowfi_dev_password@127.0.0.1:5433/flowfi   # or the CI default below",
    `    3. npx prisma db push --schema=prisma/schema.prisma  # then:  npm run test:integration`,
    `  CI default: ${DEFAULT_TEST_DATABASE_URL}`,
  ].join("\n");
}
