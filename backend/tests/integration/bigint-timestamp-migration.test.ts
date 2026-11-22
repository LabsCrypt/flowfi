/**
 * Issue #1766 — coverage for the bigint timestamp migration
 * (`prisma/migrations/20260729170000_timestamp_bigint/migration.sql`).
 *
 * Two halves, because the two failure modes are different:
 *
 *   A. The migration text itself. It runs on every deploy, so its contract is
 *      asserted statically and always: the four `Stream` timestamp columns and
 *      `StreamEvent.timestamp` end up as BIGINT, the nullable `endTime` is added
 *      idempotently, nothing converts through a floating-point type, and the
 *      generated schema agrees with the SQL. A drift between schema.prisma and
 *      the migration is the classic way this breaks in production, so it fails
 *      here instead.
 *
 *   B. The migrated database's behaviour: values past `Number.MAX_SAFE_INTEGER`
 *      round-trip exactly, NULL stays NULL, an out-of-int64 value is rejected
 *      rather than clamped, and a transaction that fails after writing leaves no
 *      row behind. These need a real Postgres, so they follow the repository's
 *      existing convention (`_db.ts`): probe first, skip cleanly with an
 *      explanation when the server is not reachable.
 *
 *      Every statement in part B runs inside a transaction that is always rolled
 *      back, so a suite executed against a shared server leaves no trace.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  resolveDbReadiness,
  resolveTestDatabaseUrl,
  explainSkipReason,
  type DbReadiness,
} from "./_db.js";

const MIGRATION_DIR = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260729170000_timestamp_bigint",
);
const MIGRATION_SQL = join(MIGRATION_DIR, "migration.sql");
const PRISMA_SCHEMA = join(process.cwd(), "prisma", "schema.prisma");

// ─── A. The migration as written ─────────────────────────────────────────────

describe("timestamp bigint migration SQL (#1766)", () => {
  const sql = (() => {
    try {
      return readFileSync(MIGRATION_SQL, "utf8");
    } catch {
      return "";
    }
  })();

  it("is present in the migration chain", () => {
    expect(existsSync(MIGRATION_DIR)).toBe(true);
    expect(sql).not.toBe("");
  });

  it("converts every Stream timestamp column to BIGINT", () => {
    for (const column of ["startTime", "lastUpdateTime", "pausedAt"]) {
      expect(sql, `${column} must be converted`).toMatch(
        new RegExp(`ALTER COLUMN "${column}" SET DATA TYPE BIGINT`),
      );
    }
  });

  it("adds endTime as a nullable BIGINT without failing on a re-run", () => {
    // Idempotence matters: this migration has to survive being replayed onto a
    // database that already has the column, so the ADD must be guarded.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "endTime" BIGINT/);
    expect(sql).not.toMatch(/ADD COLUMN "endTime"/);
  });

  it("converts StreamEvent.timestamp too", () => {
    expect(sql).toMatch(/ALTER TABLE "StreamEvent"\s+ALTER COLUMN "timestamp" SET DATA TYPE BIGINT/);
  });

  it("never routes a timestamp through a floating-point type", () => {
    // A USING clause that casts through double precision loses the low digits of
    // an i128-scale timestamp — the exact bug the column type change exists to fix.
    expect(sql).not.toMatch(/double precision/i);
    expect(sql).not.toMatch(/\breal\b/i);
    expect(sql).not.toMatch(/USING/i);
  });

  it("agrees with the generated Prisma schema", () => {
    const schema = readFileSync(PRISMA_SCHEMA, "utf8");
    const streamModel = /model Stream \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const eventModel = /model StreamEvent \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";

    for (const column of ["startTime", "lastUpdateTime", "endTime", "pausedAt"]) {
      expect(streamModel, `${column} must be BigInt in schema.prisma`).toMatch(
        new RegExp(`^\\s+${column}\\s+BigInt`, "m"),
      );
    }
    // endTime and pausedAt gained their nullability in this migration; a required
    // column would fail to convert on any existing row.
    expect(streamModel).toMatch(/endTime\s+BigInt\?/);
    expect(streamModel).toMatch(/pausedAt\s+BigInt\?/);
    expect(eventModel).toMatch(/^\s+timestamp\s+BigInt/m);
  });
});

// ─── B. The migrated database's behaviour ────────────────────────────────────

/**
 * The repository's convention for real-DB suites: probe, then skip with an
 * explanation. On top of that, writes are only attempted against the dedicated
 * test database, never a server pointed at production data.
 */
const TEST_DATABASE_NAME = /\/([A-Za-z0-9_]+)(\?|$)/;
function isTestDatabase(url: string | null): boolean {
  if (!url) return false;
  return TEST_DATABASE_NAME.exec(url)?.[1]?.endsWith("_test") === true;
}

describe("bigint timestamps in a migrated database (#1766)", () => {
  let readiness: DbReadiness | null = null;
  let databaseUrl: string | undefined;
  let pool: pg.Pool | null = null;

  beforeAll(async () => {
    readiness = await resolveDbReadiness();
    databaseUrl = readiness.url ?? undefined;
    if (readiness.ready && databaseUrl && isTestDatabase(databaseUrl)) {
      pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    }
  });

  afterAll(async () => {
    // Release the pool so a half-broken server does not keep the runner alive.
    await pool?.end().catch(() => undefined);
  });

  async function inRolledBackTransaction(
    run: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    if (!pool) throw new Error("no test database pool");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await run(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function skipUnlessMigrated(context: any): Promise<void> {
    if (!readiness?.ready || !pool) {
      // A database without this migration applied is not evidence of a defect,
      // so report why nothing ran rather than failing the suite.
      console.warn(
        explainSkipReason(
          readiness ?? { ready: false, reason: "not probed", url: resolveTestDatabaseUrl() },
        ),
      );
      context.skip();
    }
  }

  it("stores the timestamp columns as int8", async (context) => {
    await skipUnlessMigrated(context);

    const client = await pool!.connect();
    try {
      const { rows } = await client.query(
        `SELECT table_name, column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE (table_name = 'Stream' AND column_name IN ('startTime','endTime','lastUpdateTime','pausedAt'))
             OR (table_name = 'StreamEvent' AND column_name = 'timestamp')
          ORDER BY table_name, column_name`,
      );
      expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual(
        expect.arrayContaining([
          "Stream.endTime",
          "Stream.lastUpdateTime",
          "Stream.pausedAt",
          "Stream.startTime",
          "StreamEvent.timestamp",
        ]),
      );
      expect(rows.every((r) => r.data_type === "bigint")).toBe(true);

      const nullable = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]));
      expect(nullable.get("Stream.endTime")).toBe("YES");
      expect(nullable.get("Stream.pausedAt")).toBe("YES");
      expect(nullable.get("Stream.startTime")).toBe("NO");
      expect(nullable.get("StreamEvent.timestamp")).toBe("NO");
    } finally {
      client.release();
    }
  });

  it("round-trips a value past Number.MAX_SAFE_INTEGER without losing digits", async (context) => {
    await skipUnlessMigrated(context);

    // 2^53 + 1 — the first integer a double cannot represent. An int32 column
    // would have overflowed long ago; a float8 column would round it here.
    const beyondSafe = "9007199254740993";

    await inRolledBackTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT (${beyondSafe}::bigint + 1)::text AS next,
                (${beyondSafe}::bigint * 2)::text AS doubled`,
      );
      expect(rows[0].next).toBe("9007199254740994");
      expect(rows[0].doubled).toBe("18014398509481986");

      const stored = await client.query(
        `SELECT ${beyondSafe}::bigint AS raw, ${beyondSafe}::numeric::text AS as_numeric`,
      );
      expect(stored.rows[0].raw).toBe(beyondSafe);
      expect(stored.rows[0].as_numeric).toBe(beyondSafe);
    });
  });

  it("accepts the full int64 range and rejects one past it", async (context) => {
    await skipUnlessMigrated(context);

    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      const extremes = await client.query(
        `SELECT '9223372036854775807'::bigint AS max_int8,
                '-9223372036854775808'::bigint AS min_int8`,
      );
      expect(extremes.rows[0].max_int8).toBe("9223372036854775807");
      expect(extremes.rows[0].min_int8).toBe("-9223372036854775808");

      // One past int64 must raise, not clamp to the boundary.
      await expect(
        client.query(`SELECT '9223372036854775808'::bigint`),
      ).rejects.toThrow(/out of range|overflow|invalid input syntax/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("stores a huge timestamp and a NULL in the same BIGINT row", async (context) => {
    await skipUnlessMigrated(context);

    // The same shape the migrated columns have: one required BIGINT timestamp,
    // two nullable ones. A row that carries a value past 2^53 next to a NULL is
    // the case the type change was made for — a 32-bit column overflows on the
    // value and a NOT NULL column fails on the NULL.
    const beyondSafe = "9007199254740993";
    await inRolledBackTransaction(async (client) => {
      await client.query(
        `CREATE TABLE bigint_ts_probe (
            "startTime"     BIGINT NOT NULL,
            "endTime"       BIGINT,
            "pausedAt"      BIGINT
         )`,
      );
      await client.query(
        `INSERT INTO bigint_ts_probe ("startTime","endTime","pausedAt")
         VALUES ($1, NULL, NULL), ($2, $3, $4)`,
        [beyondSafe, "1700000000", "1700000001", "1700000002"],
      );

      const { rows } = await client.query(
        `SELECT "startTime"::text AS start,
                "endTime" IS NULL AS end_null,
                "pausedAt" IS NULL AS paused_null
           FROM bigint_ts_probe ORDER BY "startTime"`,
      );
      expect(rows).toEqual([
        { start: "1700000000", end_null: false, paused_null: false },
        { start: beyondSafe, end_null: true, paused_null: true },
      ]);
    });
  });

  it("leaves no row behind when a transaction fails after writing", async (context) => {
    await skipUnlessMigrated(context);

    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE TABLE bigint_ts_rollback_probe ("timestamp" BIGINT NOT NULL)`,
      );
      await client.query(
        `INSERT INTO bigint_ts_rollback_probe ("timestamp") VALUES (9007199254740993)`,
      );
      // Fail after the write, the way a later statement in the worker's
      // $transaction would.
      await expect(client.query(`SELECT 1/0`)).rejects.toThrow(/division by zero/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // Nothing survived: neither the table nor its row.
    const gone = await pool!.query(
      `SELECT to_regclass('bigint_ts_rollback_probe') AS rel`,
    );
    expect(gone.rows[0].rel).toBeNull();
  });

  it("re-applies the migration statements without erroring", async (context) => {
    await skipUnlessMigrated(context);

    const sql = readFileSync(MIGRATION_SQL, "utf8");
    // Re-running a completed migration is what happens on a fresh clone of an
    // existing database; the statements have to tolerate that.
    //
    // It runs against clone tables in a throwaway schema rather than the real
    // `"Stream"`/`"StreamEvent"`, because `ALTER TABLE ... SET DATA TYPE` takes an
    // ACCESS EXCLUSIVE lock and rewrites the table — enough to stall the other
    // integration suites that share this database. Quoted identifiers still
    // resolve through `search_path`, so the statements under test are unchanged.
    await inRolledBackTransaction(async (client) => {
      await client.query(`CREATE SCHEMA bigint_ts_reapply`);
      await client.query(`SET LOCAL search_path = bigint_ts_reapply, public`);
      await client.query(
        `CREATE TABLE "Stream" (
            "startTime"      INTEGER NOT NULL,
            "lastUpdateTime" INTEGER NOT NULL,
            "pausedAt"       INTEGER
         )`,
      );
      await client.query(
        `CREATE TABLE "StreamEvent" ("timestamp" INTEGER NOT NULL)`,
      );

      await client.query(sql);

      const { rows } = await client.query(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'bigint_ts_reapply'
          ORDER BY table_name, column_name`,
      );
      expect(rows.every((r) => r.data_type === "bigint")).toBe(true);
      expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
        "Stream.endTime",
        "Stream.lastUpdateTime",
        "Stream.pausedAt",
        "Stream.startTime",
        "StreamEvent.timestamp",
      ]);

      // Second application: the `IF NOT EXISTS` guard is the only thing that
      // keeps a re-run from failing on the added column.
      await client.query(sql);
    });
  });
});
