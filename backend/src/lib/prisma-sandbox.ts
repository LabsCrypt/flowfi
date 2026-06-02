import { PrismaClient } from '../generated/prisma/index.js';

const globalForSandboxPrisma = globalThis as unknown as {
  sandboxPrisma: PrismaClient | undefined;
};

export function getSandboxPrisma(): PrismaClient {
  if (globalForSandboxPrisma.sandboxPrisma) {
    return globalForSandboxPrisma.sandboxPrisma;
  }

  const sandboxPrisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  } as any);

  if (process.env.NODE_ENV !== 'production') {
    globalForSandboxPrisma.sandboxPrisma = sandboxPrisma;
  }

  return sandboxPrisma;
}

/**
 * Get the appropriate Prisma client based on sandbox mode
 */
export async function getPrismaClient(isSandbox: boolean): Promise<PrismaClient> {
  if (isSandbox) {
    return getSandboxPrisma();
  }
  
  // Import production prisma client dynamically
  const { prisma } = await import('./prisma.js');
  return prisma;
}
