import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindUnique = vi.fn();
const mockCreate = vi.fn();

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    indexerState: {
      findUnique: mockFindUnique,
      create: mockCreate,
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { ensureIndexerState } from '../src/lib/indexer-state.js';

describe('ensureIndexerState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing row if it already exists', async () => {
    const existing = {
      id: 'singleton',
      lastLedger: 42,
      lastCursor: 'cur',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockFindUnique.mockResolvedValueOnce(existing);

    const result = await ensureIndexerState(0);

    expect(result).toEqual(existing);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates and returns a new row when none exists', async () => {
    const created = {
      id: 'singleton',
      lastLedger: 10,
      lastCursor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockFindUnique.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(created);

    const result = await ensureIndexerState(10);

    expect(result).toEqual(created);
    expect(mockCreate).toHaveBeenCalledWith({
      data: { id: 'singleton', lastLedger: 10, lastCursor: null },
    });
  });

  it('re-reads the row on unique-constraint violation (P2002) without throwing', async () => {
    const existingRow = {
      id: 'singleton',
      lastLedger: 5,
      lastCursor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // First findUnique returns null (no row yet)
    mockFindUnique.mockResolvedValueOnce(null);
    // Create throws P2002 (race condition duplicate insert)
    const p2002Error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mockCreate.mockRejectedValueOnce(p2002Error);
    // Second findUnique returns the existing row created by the concurrent caller
    mockFindUnique.mockResolvedValueOnce(existingRow);

    const result = await ensureIndexerState(0);

    expect(result).toEqual(existingRow);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it('re-throws non-P2002 errors', async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const genericError = new Error('connection refused');
    mockCreate.mockRejectedValueOnce(genericError);

    await expect(ensureIndexerState(0)).rejects.toThrow('connection refused');
  });
});
