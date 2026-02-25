import { PrismaClient } from '../generated/prisma/index.js';
import { getSandboxConfig } from '../config/sandbox.js';

/**
 * Sandbox Prisma Client
 * 
 * Uses a separate database connection for sandbox mode to ensure
 * complete isolation from production data.
 */

const globalForSandboxPrisma = globalThis as unknown as {
  sandboxPrisma: PrismaClient | undefined;
};

/**
 * Get sandbox Prisma client instance
 * 
 * If SANDBOX_DATABASE_URL is set, uses that database.
 * Otherwise, uses the default DATABASE_URL with a sandbox suffix.
 */
export function getSandboxPrisma(): PrismaClient {
  const config = getSandboxConfig();
  
  // Use sandbox-specific database URL if provided
  const databaseUrl = config.databaseUrl || 
    (process.env.DATABASE_URL 
      ? `${process.env.DATABASE_URL}_sandbox` 
      : 'file:./sandbox.db');

  if (globalForSandboxPrisma.sandboxPrisma) {
    return globalForSandboxPrisma.sandboxPrisma;
  }

  const sandboxPrisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn'] 
      : ['error'],
  });

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
