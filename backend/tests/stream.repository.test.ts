import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateStatus } from '../src/repositories/stream.repository.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      update: vi.fn(),
    },
  },
}));

describe('Stream Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update isActive to false for CANCELLED', async () => {
    await updateStatus(123, 'CANCELLED');
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: 123 },
      data: { isActive: false },
    });
  });

  it('should update isActive to false for COMPLETED', async () => {
    await updateStatus(123, 'COMPLETED');
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: 123 },
      data: { isActive: false },
    });
  });

  it('should update isActive to true for ACTIVE', async () => {
    await updateStatus(123, 'ACTIVE');
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: 123 },
      data: { isActive: true },
    });
  });

  it('should update isActive to true for PAUSED', async () => {
    await updateStatus(123, 'PAUSED');
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: 123 },
      data: { isActive: true },
    });
  });
});
