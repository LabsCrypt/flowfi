import { prisma } from '../lib/prisma.js';

/**
 * Update the status and active flag of a stream in the database.
 */
export const updateStatus = async (streamId: number, status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'PAUSED') => {
  return prisma.stream.update({
    where: { streamId },
    data: {
      isActive: status === 'ACTIVE' || status === 'PAUSED',
      // Note: we don't have a 'status' field in the Stream model yet,
      // it seems status is derived from isActive and events.
      // However, we can update isActive to false for CANCELLED/COMPLETED.
    }
  });
};
