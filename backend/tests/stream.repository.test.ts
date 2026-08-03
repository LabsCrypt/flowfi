import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateStatus, findStreams } from '../src/repositories/stream.repository.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

describe('Stream Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('updateStatus', () => {
    it('should update isActive to false for CANCELLED', async () => {
      await updateStatus(123n, 'CANCELLED');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: false },
      });
    });

    it('should update isActive to false for COMPLETED', async () => {
      await updateStatus(123n, 'COMPLETED');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: false },
      });
    });

    it('should update isActive to true for ACTIVE', async () => {
      await updateStatus(123n, 'ACTIVE');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: true },
      });
    });

    it('should update isActive to true for PAUSED', async () => {
      await updateStatus(123n, 'PAUSED');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: true },
      });
    });
  });

  describe('findStreams', () => {
    const baseParams = { limit: 10, offset: 0 };

    it('should query with default sort when no sort params given', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams(baseParams);

      expect(prisma.stream.findMany).toHaveBeenCalledWith(expect.objectContaining({
        orderBy: { startTime: 'desc' },
        take: 10,
        skip: 0,
      }));
    });

    it('should filter by sender when provided', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, sender: 'GSENDER' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sender: 'GSENDER' }),
        }),
      );
    });

    it('should filter active streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'active' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true, isPaused: false }),
        }),
      );
    });

    it('should filter paused streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'paused' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isPaused: true }),
        }),
      );
    });

    it('should filter cancelled streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'cancelled' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
            events: { some: { eventType: 'CANCELLED' } },
          }),
        }),
      );
    });

    it('should filter completed streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'completed' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
            events: { some: { eventType: 'COMPLETED' } },
          }),
        }),
      );
    });

    it('should apply limit and offset for pagination', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ limit: 5, offset: 10 });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 10 }),
      );
    });

    it('should return hasMore true when more results exist', async () => {
      (prisma.stream.findMany as any).mockResolvedValue(Array(10).fill({}));
      (prisma.stream.count as any).mockResolvedValue(15);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(15);
      expect(result.streams).toHaveLength(10);
    });

    it('should return hasMore false when at end of results', async () => {
      (prisma.stream.findMany as any).mockResolvedValue(Array(5).fill({}));
      (prisma.stream.count as any).mockResolvedValue(5);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.hasMore).toBe(false);
      expect(result.total).toBe(5);
      expect(result.streams).toHaveLength(5);
    });
  });
});
