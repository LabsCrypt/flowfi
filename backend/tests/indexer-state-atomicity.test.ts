import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { indexerState: mocks },
}));

vi.mock('../src/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureIndexerState, INDEXER_STATE_ID } from '../src/lib/indexer-state.js';
import logger from '../src/logger.js';

type Row = { id: string; lastLedger: number; lastCursor: string | null };

const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function row(overrides: Partial<Row> = {}): Row {
  return { id: INDEXER_STATE_ID, lastLedger: 7, lastCursor: 's0000000000000001:0', ...overrides };
}

describe('indexer state row atomicity (#1751)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the existing row untouched and writes nothing when the singleton is present', async () => {
    const existing = row({ lastLedger: 4242 });
    mocks.findUnique.mockResolvedValueOnce(existing);

    const result = await ensureIndexerState(1);

    expect(result).toBe(existing);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: INDEXER_STATE_ID } });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('inserts the singleton with a null cursor on the first call', async () => {
    const created = row();
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.create.mockResolvedValueOnce(created);

    await expect(ensureIndexerState(10)).resolves.toBe(created);

    expect(mocks.create).toHaveBeenCalledWith({
      data: { id: INDEXER_STATE_ID, lastLedger: 10, lastCursor: null },
    });
  });

  it('does not clamp the configured start ledger', async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }: { data: Row }) => row(data));

    for (const startLedger of [0, -1, Number.MAX_SAFE_INTEGER]) {
      await ensureIndexerState(startLedger);
      expect(mocks.create).toHaveBeenLastCalledWith({
        data: { id: INDEXER_STATE_ID, lastLedger: startLedger, lastCursor: null },
      });
    }
  });

  it('throws the documented error when the P2002 retry finds no row', async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.create.mockRejectedValueOnce(p2002());
    mocks.findUnique.mockResolvedValueOnce(null);

    await expect(ensureIndexerState(5)).rejects.toThrow(
      '[IndexerState] Unique-constraint violation but row not found after race.',
    );

    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('warns once rather than logging the winning race as an error', async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
    mocks.create.mockRejectedValueOnce(p2002());

    await expect(ensureIndexerState(5)).resolves.toMatchObject({ lastLedger: 7 });

    expect(logger.warn).toHaveBeenCalledWith(
      '[IndexerState] Concurrent first-insert detected; re-reading existing row.',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('surfaces a failed initial read instead of attempting a duplicate insert', async () => {
    const outage = new Error('connection reset by peer');
    mocks.findUnique.mockRejectedValueOnce(outage);

    await expect(ensureIndexerState(5)).rejects.toBe(outage);

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('propagates the retry read failure instead of the bespoke race message', async () => {
    const outage = new Error('connection reset by peer');
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.create.mockRejectedValueOnce(p2002());
    mocks.findUnique.mockRejectedValueOnce(outage);

    await expect(ensureIndexerState(5)).rejects.toBe(outage);
  });

  it('re-throws a non-unique insert failure unchanged', async () => {
    const timeout = new Error('pool timeout');
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.create.mockRejectedValueOnce(timeout);

    await expect(ensureIndexerState(5)).rejects.toBe(timeout);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('re-throws a non-Error rejection from the insert', async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.create.mockRejectedValueOnce('boom');

    await expect(ensureIndexerState(5)).rejects.toBe('boom');
  });

  it('settles both interleaved callers on the one winning row', async () => {
    const store: { row?: Row } = {};
    let insertAttempts = 0;
    let releaseFirst!: () => void;
    const firstInsertPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    mocks.findUnique.mockImplementation(async () => store.row ?? null);
    mocks.create.mockImplementation(async ({ data }: { data: { lastLedger: number } }) => {
      insertAttempts += 1;
      if (insertAttempts === 1) {
        // The winner holds its transaction open until the loser also tries.
        await firstInsertPending;
        store.row = { id: INDEXER_STATE_ID, lastLedger: data.lastLedger, lastCursor: null };
        return store.row;
      }
      releaseFirst();
      await Promise.resolve();
      throw p2002();
    });

    const winner = ensureIndexerState(100);
    await Promise.resolve();
    const loser = ensureIndexerState(200);

    const [winnerRow, loserRow] = await Promise.all([winner, loser]);

    expect(winnerRow).toBe(loserRow);
    expect(winnerRow.lastLedger).toBe(100);
    expect(insertAttempts).toBe(2);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    // The loser re-reads after the violation; the winner never does.
    expect(mocks.findUnique).toHaveBeenCalledTimes(3);
  });

  it('stays idempotent across repeated calls once the row exists', async () => {
    const created = row();
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValue(created);
    mocks.create.mockResolvedValueOnce(created);

    const results = await Promise.all([ensureIndexerState(1), ensureIndexerState(1), ensureIndexerState(1)]);

    expect(results.every((r) => r === created)).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledTimes(3);
  });
});
