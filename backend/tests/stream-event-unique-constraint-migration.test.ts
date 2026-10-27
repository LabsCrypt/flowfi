import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../prisma/migrations/20260428000001_add_stream_event_unique_constraint/migration.sql",
);

interface SimulatedStreamEventRow {
  id: number;
  streamId: string;
  eventType: string;
  transactionHash: string | null;
  amount?: string | null;
}

class MigrationSimulationHarness {
  public rows: SimulatedStreamEventRow[];
  public indexes = new Set<string>(["StreamEvent_transactionHash_idx"]);
  public constraints = new Set<string>();

  constructor(initialRows: SimulatedStreamEventRow[]) {
    this.rows = initialRows.map((r) => ({ ...r }));
  }

  public executeMigrationSql(sql: string): { deletedCount: number; constraintAdded: boolean } {
    // Verify migration SQL contains the three required statements in order
    const deleteIdx = sql.indexOf('DELETE FROM "StreamEvent"');
    const dropIndexIdx = sql.indexOf('DROP INDEX IF EXISTS "StreamEvent_transactionHash_idx"');
    const addConstraintIdx = sql.indexOf(
      'ADD CONSTRAINT "StreamEvent_transactionHash_eventType_key"',
    );

    if (deleteIdx === -1 || dropIndexIdx === -1 || addConstraintIdx === -1) {
      throw new Error("Migration SQL is missing required recovery statements");
    }
    if (!(deleteIdx < dropIndexIdx && dropIndexIdx < addConstraintIdx)) {
      throw new Error("Migration statements must run in order: DELETE duplicates -> DROP INDEX -> ADD CONSTRAINT");
    }

    // Step 1: Execute the exact deduplication semantics of:
    // DELETE FROM "StreamEvent"
    // WHERE id NOT IN (
    //   SELECT MIN(id) FROM "StreamEvent"
    //   WHERE "transactionHash" IS NOT NULL
    //   GROUP BY "transactionHash", "eventType"
    // )
    // AND "transactionHash" IS NOT NULL;
    const minIdByTxAndType = new Map<string, number>();
    for (const row of this.rows) {
      if (row.transactionHash !== null) {
        const key = `${row.transactionHash}::${row.eventType}`;
        const currentMin = minIdByTxAndType.get(key);
        if (currentMin === undefined || row.id < currentMin) {
          minIdByTxAndType.set(key, row.id);
        }
      }
    }
    const keptIds = new Set<number>(minIdByTxAndType.values());

    const beforeCount = this.rows.length;
    this.rows = this.rows.filter((row) => {
      if (row.transactionHash === null) {
        return true; // AND "transactionHash" IS NOT NULL preserves NULL rows
      }
      return keptIds.has(row.id);
    });
    const deletedCount = beforeCount - this.rows.length;

    // Step 2: DROP INDEX IF EXISTS "StreamEvent_transactionHash_idx"
    this.indexes.delete("StreamEvent_transactionHash_idx");

    // Step 3: DO $$ IF NOT EXISTS (pg_constraint) THEN ALTER TABLE ADD CONSTRAINT UNIQUE ("transactionHash", "eventType")
    let constraintAdded = false;
    if (!this.constraints.has("StreamEvent_transactionHash_eventType_key")) {
      // Verify no duplicates remain among non-null transactionHash rows before constraint creation
      const seen = new Set<string>();
      for (const row of this.rows) {
        if (row.transactionHash !== null) {
          const compositeKey = `${row.transactionHash}::${row.eventType}`;
          if (seen.has(compositeKey)) {
            throw new Error(
              `Cannot add unique constraint: duplicate ("transactionHash", "eventType") = (${row.transactionHash}, ${row.eventType})`,
            );
          }
          seen.add(compositeKey);
        }
      }
      this.constraints.add("StreamEvent_transactionHash_eventType_key");
      constraintAdded = true;
    }

    return { deletedCount, constraintAdded };
  }

  public insert(row: SimulatedStreamEventRow): void {
    if (
      this.constraints.has("StreamEvent_transactionHash_eventType_key") &&
      row.transactionHash !== null
    ) {
      const conflict = this.rows.find(
        (existing) =>
          existing.transactionHash === row.transactionHash &&
          existing.eventType === row.eventType,
      );
      if (conflict) {
        const err = new Error(
          'duplicate key value violates unique constraint "StreamEvent_transactionHash_eventType_key"',
        ) as Error & { code: string };
        err.code = "23505";
        throw err;
      }
    }
    this.rows.push({ ...row });
  }
}

describe("Migration 20260428000001_add_stream_event_unique_constraint recovery (#1765)", () => {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");

  it("verifies migration SQL structure orders duplicate cleanup before index drop and guarded constraint creation", () => {
    expect(migrationSql).toContain('DELETE FROM "StreamEvent"');
    expect(migrationSql).toContain('SELECT MIN(id)');
    expect(migrationSql).toContain('GROUP BY "transactionHash", "eventType"');
    expect(migrationSql).toContain('AND "transactionHash" IS NOT NULL');
    expect(migrationSql).toContain('DROP INDEX IF EXISTS "StreamEvent_transactionHash_idx"');
    expect(migrationSql).toContain("conname = 'StreamEvent_transactionHash_eventType_key'");
    expect(migrationSql).toContain('UNIQUE ("transactionHash", "eventType")');
  });

  it("cleans up duplicate (transactionHash, eventType) rows by keeping MIN(id) while preserving distinct eventTypes and NULL hashes", () => {
    const dirtyRows: SimulatedStreamEventRow[] = [
      // Triple duplicate of ('tx-alpha', 'WITHDRAWN') — should keep id=10 and delete id=25, 41
      { id: 25, streamId: "1", eventType: "WITHDRAWN", transactionHash: "tx-alpha", amount: "100" },
      { id: 10, streamId: "1", eventType: "WITHDRAWN", transactionHash: "tx-alpha", amount: "100" },
      { id: 41, streamId: "1", eventType: "WITHDRAWN", transactionHash: "tx-alpha", amount: "100" },
      // Same transactionHash 'tx-alpha' but distinct eventType 'COMPLETED' — must be preserved
      { id: 11, streamId: "1", eventType: "COMPLETED", transactionHash: "tx-alpha", amount: "500" },
      // Duplicate of ('tx-beta', 'CREATED') — should keep id=30 and delete id=31
      { id: 30, streamId: "2", eventType: "CREATED", transactionHash: "tx-beta", amount: "1000" },
      { id: 31, streamId: "2", eventType: "CREATED", transactionHash: "tx-beta", amount: "1000" },
      // Multiple rows with NULL transactionHash — must be untouched
      { id: 50, streamId: "3", eventType: "CREATED", transactionHash: null, amount: "200" },
      { id: 51, streamId: "3", eventType: "CREATED", transactionHash: null, amount: "200" },
    ];

    const harness = new MigrationSimulationHarness(dirtyRows);
    const result = harness.executeMigrationSql(migrationSql);

    expect(result.deletedCount).toBe(3); // deleted ids: 25, 41, 31
    expect(result.constraintAdded).toBe(true);
    expect(harness.indexes.has("StreamEvent_transactionHash_idx")).toBe(false);
    expect(harness.constraints.has("StreamEvent_transactionHash_eventType_key")).toBe(true);

    const remainingIds = harness.rows.map((r) => r.id).sort((a, b) => a - b);
    expect(remainingIds).toEqual([10, 11, 30, 50, 51]);
  });

  it("is idempotent when the migration is rerun against an already-migrated schema", () => {
    const initialRows: SimulatedStreamEventRow[] = [
      { id: 1, streamId: "1", eventType: "CREATED", transactionHash: "tx-1" },
      { id: 2, streamId: "1", eventType: "CREATED", transactionHash: "tx-1" },
      { id: 3, streamId: "1", eventType: "WITHDRAWN", transactionHash: "tx-2" },
    ];

    const harness = new MigrationSimulationHarness(initialRows);

    const firstRun = harness.executeMigrationSql(migrationSql);
    expect(firstRun).toEqual({ deletedCount: 1, constraintAdded: true });
    expect(harness.rows.map((r) => r.id)).toEqual([1, 3]);

    // Rerun migration SQL: DROP INDEX IF EXISTS and IF NOT EXISTS (pg_constraint) must succeed cleanly
    const secondRun = harness.executeMigrationSql(migrationSql);
    expect(secondRun).toEqual({ deletedCount: 0, constraintAdded: false });
    expect(harness.rows.map((r) => r.id)).toEqual([1, 3]);
    expect(harness.constraints.has("StreamEvent_transactionHash_eventType_key")).toBe(true);
  });

  it("enforces the composite unique constraint after migration while allowing distinct event types in one transaction", () => {
    const harness = new MigrationSimulationHarness([
      { id: 1, streamId: "1", eventType: "WITHDRAWN", transactionHash: "tx-final" },
    ]);
    harness.executeMigrationSql(migrationSql);

    // Same txHash with a different eventType (e.g. COMPLETED alongside WITHDRAWN) is allowed
    expect(() =>
      harness.insert({
        id: 2,
        streamId: "1",
        eventType: "COMPLETED",
        transactionHash: "tx-final",
      }),
    ).not.toThrow();

    // Duplicate (transactionHash, eventType) is rejected with Postgres 23505 unique violation
    expect(() =>
      harness.insert({
        id: 3,
        streamId: "1",
        eventType: "WITHDRAWN",
        transactionHash: "tx-final",
      }),
    ).toThrow(/StreamEvent_transactionHash_eventType_key/);
  });
});
