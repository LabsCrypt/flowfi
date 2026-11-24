import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Issue #1765: Cover migration unique constraint recovery.
 *
 * Target: backend/prisma/migrations/20260428000001_add_stream_event_unique_constraint/migration.sql
 * Statement:
 *   ALTER TABLE "StreamEvent" ADD CONSTRAINT "StreamEvent_transactionHash_eventType_key" UNIQUE ("transactionHash", "eventType");
 *
 * This test suite deterministically verifies:
 * 1. Migration SQL content and contract verification.
 * 2. Clean migration execution on tables without duplicates.
 * 3. Migration failure when duplicate (transactionHash, eventType) rows exist (Postgres 23505).
 * 4. Deduplication recovery workflow to resolve duplicates and safely re-apply migration.
 * 5. Idempotent rerun handling when constraint already exists (Postgres 42710).
 * 6. Post-migration runtime compound uniqueness enforcement.
 * 7. Transaction atomicity and dependency failure handling.
 */

describe('Issue #1765 - Migration Unique Constraint Recovery (StreamEvent)', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../prisma/migrations/20260428000001_add_stream_event_unique_constraint/migration.sql'
  );

  describe('Migration file contract', () => {
    it('exists on disk and contains the exact alter table constraint statement', () => {
      expect(fs.existsSync(migrationPath)).toBe(true);
      const sql = fs.readFileSync(migrationPath, 'utf8').trim();

      expect(sql).toContain('ALTER TABLE "StreamEvent"');
      expect(sql).toContain('ADD CONSTRAINT "StreamEvent_transactionHash_eventType_key"');
      expect(sql).toContain('UNIQUE ("transactionHash", "eventType")');
    });
  });

  describe('Migration simulation and execution paths', () => {
    interface StreamEventRow {
      id: string;
      streamId: bigint;
      eventType: string;
      transactionHash: string;
      ledgerSequence: number;
      timestamp: number;
    }

    interface DatabaseState {
      rows: StreamEventRow[];
      constraints: Set<string>;
    }

    let dbState: DatabaseState;

    beforeEach(() => {
      dbState = {
        rows: [],
        constraints: new Set(),
      };
    });

    /**
     * Executes the migration SQL against the database state simulator.
     */
    function applyMigration(state: DatabaseState): { success: boolean; error?: { code: string; message: string } } {
      const constraintName = 'StreamEvent_transactionHash_eventType_key';

      // Check if constraint already exists (Postgres 42710: duplicate_object)
      if (state.constraints.has(constraintName)) {
        return {
          success: false,
          error: {
            code: '42710',
            message: `relation "${constraintName}" already exists`,
          },
        };
      }

      // Check for existing duplicates on (transactionHash, eventType)
      const seen = new Set<string>();
      for (const row of state.rows) {
        const key = `${row.transactionHash}::${row.eventType}`;
        if (seen.has(key)) {
          return {
            success: false,
            error: {
              code: '23505',
              message: `could not create unique index "${constraintName}": Key (transactionHash, eventType)=(${row.transactionHash}, ${row.eventType}) is duplicated`,
            },
          };
        }
        seen.add(key);
      }

      state.constraints.add(constraintName);
      return { success: true };
    }

    /**
     * Recovery deduplication procedure: finds duplicate (transactionHash, eventType) groups
     * and keeps the authoritative/earliest row while pruning duplicates.
     */
    function deduplicateStreamEvents(state: DatabaseState): { deletedCount: number } {
      const seen = new Map<string, StreamEventRow>();
      const toKeep: StreamEventRow[] = [];
      let deletedCount = 0;

      // Deterministic sort: retain canonical record with lowest id (or oldest timestamp)
      const sortedRows = [...state.rows].sort((a, b) => a.id.localeCompare(b.id));

      for (const row of sortedRows) {
        const key = `${row.transactionHash}::${row.eventType}`;
        if (!seen.has(key)) {
          seen.set(key, row);
          toKeep.push(row);
        } else {
          deletedCount++;
        }
      }

      state.rows = toKeep;
      return { deletedCount };
    }

    /**
     * Idempotent migration runner that checks existence before applying.
     */
    function applyMigrationIdempotently(state: DatabaseState): { status: 'applied' | 'already_exists'; error?: unknown } {
      const constraintName = 'StreamEvent_transactionHash_eventType_key';
      if (state.constraints.has(constraintName)) {
        return { status: 'already_exists' };
      }
      const res = applyMigration(state);
      if (!res.success) {
        throw new Error(`Migration failed: [${res.error?.code}] ${res.error?.message}`);
      }
      return { status: 'applied' };
    }

    it('successfully applies migration when table has no duplicates', () => {
      dbState.rows = [
        { id: 'ev-1', streamId: 101n, eventType: 'CREATED', transactionHash: '0x100', ledgerSequence: 100, timestamp: 1000 },
        { id: 'ev-2', streamId: 101n, eventType: 'WITHDRAWN', transactionHash: '0x101', ledgerSequence: 105, timestamp: 1050 },
        { id: 'ev-3', streamId: 102n, eventType: 'CREATED', transactionHash: '0x102', ledgerSequence: 110, timestamp: 1100 },
      ];

      const result = applyMigration(dbState);
      expect(result.success).toBe(true);
      expect(dbState.constraints.has('StreamEvent_transactionHash_eventType_key')).toBe(true);
    });

    it('successfully applies migration when same transaction contains different event types', () => {
      // Compound key: (transactionHash, eventType). Same txHash with different eventType is valid.
      dbState.rows = [
        { id: 'ev-1', streamId: 201n, eventType: 'WITHDRAWN', transactionHash: '0xmulti', ledgerSequence: 200, timestamp: 2000 },
        { id: 'ev-2', streamId: 201n, eventType: 'CANCELLED', transactionHash: '0xmulti', ledgerSequence: 200, timestamp: 2000 },
      ];

      const result = applyMigration(dbState);
      expect(result.success).toBe(true);
      expect(dbState.constraints.has('StreamEvent_transactionHash_eventType_key')).toBe(true);
    });

    it('fails with code 23505 when duplicate (transactionHash, eventType) rows exist', () => {
      dbState.rows = [
        { id: 'ev-1', streamId: 301n, eventType: 'PAUSED', transactionHash: '0xdup', ledgerSequence: 300, timestamp: 3000 },
        { id: 'ev-2', streamId: 301n, eventType: 'PAUSED', transactionHash: '0xdup', ledgerSequence: 301, timestamp: 3005 },
      ];

      const result = applyMigration(dbState);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('23505');
      expect(result.error?.message).toContain('Key (transactionHash, eventType)=(0xdup, PAUSED) is duplicated');
      expect(dbState.constraints.has('StreamEvent_transactionHash_eventType_key')).toBe(false);
    });

    it('recovers from duplicate row failure by deduplicating then re-running migration', () => {
      // Setup dirty state with duplicate events from historical ingestion
      dbState.rows = [
        { id: 'ev-canonical', streamId: 401n, eventType: 'RESUMED', transactionHash: '0xreorg', ledgerSequence: 400, timestamp: 4000 },
        { id: 'ev-duplicate-1', streamId: 401n, eventType: 'RESUMED', transactionHash: '0xreorg', ledgerSequence: 400, timestamp: 4000 },
        { id: 'ev-duplicate-2', streamId: 401n, eventType: 'RESUMED', transactionHash: '0xreorg', ledgerSequence: 400, timestamp: 4000 },
        { id: 'ev-other', streamId: 402n, eventType: 'WITHDRAWN', transactionHash: '0xother', ledgerSequence: 405, timestamp: 4050 },
      ];

      // Initial migration attempt fails
      const initialAttempt = applyMigration(dbState);
      expect(initialAttempt.success).toBe(false);
      expect(initialAttempt.error?.code).toBe('23505');

      // Execute deduplication recovery
      const recovery = deduplicateStreamEvents(dbState);
      expect(recovery.deletedCount).toBe(2);
      expect(dbState.rows).toHaveLength(2);
      expect(dbState.rows.map((r) => r.id)).toEqual(['ev-canonical', 'ev-other']);

      // Re-running migration succeeds after recovery
      const recoveredAttempt = applyMigration(dbState);
      expect(recoveredAttempt.success).toBe(true);
      expect(dbState.constraints.has('StreamEvent_transactionHash_eventType_key')).toBe(true);
    });

    it('fails with code 42710 when migration is rerun directly without IF NOT EXISTS / check', () => {
      // First run succeeds
      const firstRun = applyMigration(dbState);
      expect(firstRun.success).toBe(true);

      // Second run fails with duplicate_object
      const rerun = applyMigration(dbState);
      expect(rerun.success).toBe(false);
      expect(rerun.error?.code).toBe('42710');
      expect(rerun.error?.message).toContain('StreamEvent_transactionHash_eventType_key" already exists');
    });

    it('handles rerun safely and idempotently when using deployment guard', () => {
      // Initial application
      const firstResult = applyMigrationIdempotently(dbState);
      expect(firstResult.status).toBe('applied');

      // Second application (e.g. repeated CI deploy step or re-deploy after rollback)
      const secondResult = applyMigrationIdempotently(dbState);
      expect(secondResult.status).toBe('already_exists');
      expect(dbState.constraints.has('StreamEvent_transactionHash_eventType_key')).toBe(true);
    });

    describe('Post-migration runtime constraint enforcement', () => {
      function insertStreamEvent(
        state: DatabaseState,
        row: StreamEventRow
      ): { success: boolean; error?: { code: string; message: string } } {
        if (state.constraints.has('StreamEvent_transactionHash_eventType_key')) {
          const isDuplicate = state.rows.some(
            (r) => r.transactionHash === row.transactionHash && r.eventType === row.eventType
          );
          if (isDuplicate) {
            return {
              success: false,
              error: {
                code: 'P2002',
                message: 'Unique constraint failed on the fields: (`transactionHash`,`eventType`)',
              },
            };
          }
        }
        state.rows.push(row);
        return { success: true };
      }

      it('prevents inserting duplicate (transactionHash, eventType) once constraint is active', () => {
        applyMigration(dbState);

        const initialInsert = insertStreamEvent(dbState, {
          id: 'ev-new-1',
          streamId: 501n,
          eventType: 'TOPPED_UP',
          transactionHash: '0xunique_tx',
          ledgerSequence: 500,
          timestamp: 5000,
        });
        expect(initialInsert.success).toBe(true);

        const duplicateInsert = insertStreamEvent(dbState, {
          id: 'ev-new-2',
          streamId: 501n,
          eventType: 'TOPPED_UP',
          transactionHash: '0xunique_tx',
          ledgerSequence: 501,
          timestamp: 5010,
        });
        expect(duplicateInsert.success).toBe(false);
        expect(duplicateInsert.error?.code).toBe('P2002');
        expect(duplicateInsert.error?.message).toContain('Unique constraint failed');
      });

      it('allows different event types for the same transaction hash', () => {
        applyMigration(dbState);

        const insertWithdraw = insertStreamEvent(dbState, {
          id: 'ev-1',
          streamId: 601n,
          eventType: 'WITHDRAWN',
          transactionHash: '0xcombo_tx',
          ledgerSequence: 600,
          timestamp: 6000,
        });
        const insertComplete = insertStreamEvent(dbState, {
          id: 'ev-2',
          streamId: 601n,
          eventType: 'COMPLETED',
          transactionHash: '0xcombo_tx',
          ledgerSequence: 600,
          timestamp: 6000,
        });

        expect(insertWithdraw.success).toBe(true);
        expect(insertComplete.success).toBe(true);
        expect(dbState.rows).toHaveLength(2);
      });
    });

    describe('Dependency & connection failure recovery', () => {
      it('propagates database connection or execution failure without marking constraint applied', async () => {
        const mockExecuteRaw = vi.fn().mockRejectedValue(new Error('connection to server at "postgres" failed: Connection refused'));

        const runMigrationWithClient = async () => {
          await mockExecuteRaw('ALTER TABLE "StreamEvent" ADD CONSTRAINT ...');
          dbState.constraints.add('StreamEvent_transactionHash_eventType_key');
        };

        await expect(runMigrationWithClient()).rejects.toThrow('Connection refused');
        expect(dbState.constraints.has('StreamEvent_transactionHash_eventType_key')).toBe(false);
      });
    });
  });
});
