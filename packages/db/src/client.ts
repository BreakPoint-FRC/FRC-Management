import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * A client bound to a connection string given at call time.
 *
 * The singleton above reads DATABASE_URL once, when this module is first
 * imported, which is right for the app and wrong for the API integration
 * suite: that one creates a throwaway database per run and only learns its
 * name after the import has happened. Everything else keeps using `prisma`.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export * from "./generated/prisma/client";
