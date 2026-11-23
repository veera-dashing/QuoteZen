import { PrismaClient } from '@prisma/client';

/**
 * Shared Prisma client. A single instance is reused across the process (and across hot reloads in
 * dev) to avoid exhausting the Postgres connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export const TX_OPTS = { maxWait: 20000, timeout: 45000 };

const rawTransaction = prisma.$transaction.bind(prisma);
// Patch interactive transactions to default to a 45s timeout for remote cloud DB latency.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$transaction = (arg: any, options?: any) => {
  if (typeof arg === 'function') {
    return rawTransaction(arg, { ...TX_OPTS, ...options });
  }
  return rawTransaction(arg, options);
};

export * from '@prisma/client';
