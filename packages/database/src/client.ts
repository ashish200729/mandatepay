import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type DatabaseClient = PrismaClient;

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create the MandatePay database client.");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as typeof globalThis & {
  mandatePayPrisma?: PrismaClient;
};

/**
 * Lazily creates one client per process. Lazy creation keeps pure validation and
 * unit tests usable without a database URL while API consumers still get the
 * standard singleton behavior.
 */
export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.mandatePayPrisma) {
    globalForPrisma.mandatePayPrisma = createPrismaClient();
  }

  return globalForPrisma.mandatePayPrisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (globalForPrisma.mandatePayPrisma) {
    await globalForPrisma.mandatePayPrisma.$disconnect();
    delete globalForPrisma.mandatePayPrisma;
  }
}
