import { prisma } from './prisma.js';
import type { IndexerState } from '../generated/prisma/index.js';
import logger from '../logger.js';

export const INDEXER_STATE_ID = 'singleton';

export type IndexerStateRow = IndexerState;

/**
 * Ensure the singleton indexer_state row exists.
 * Uses a catch-and-retry pattern to handle the race condition where two
 * concurrent callers attempt the first insert simultaneously. If the
 * unique-constraint violation fires, we treat it as success and re-read.
 */
export async function ensureIndexerState(
  startLedger: number,
): Promise<IndexerStateRow> {
  const existing = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  if (existing) return existing;

  try {
    const created = await prisma.indexerState.create({
      data: {
        id: INDEXER_STATE_ID,
        lastLedger: startLedger,
        lastCursor: null,
      },
    });
    return created;
  } catch (err: unknown) {
    // P2002 = Prisma unique-constraint violation (code "P2002")
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      logger.warn(
        '[IndexerState] Concurrent first-insert detected; re-reading existing row.',
      );
      const existingAfterRace = await prisma.indexerState.findUnique({
        where: { id: INDEXER_STATE_ID },
      });
      if (!existingAfterRace) {
        throw new Error(
          '[IndexerState] Unique-constraint violation but row not found after race.',
        );
      }
      return existingAfterRace;
    }
    throw err;
  }
}
