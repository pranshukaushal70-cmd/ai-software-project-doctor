import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";

const globalForPrisma = globalThis as unknown as { __pdPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Lazily-created singleton. Reused across Next.js hot reloads in development
 * so we don't exhaust Postgres connections.
 */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__pdPrisma) {
    globalForPrisma.__pdPrisma = createClient();
  }
  return globalForPrisma.__pdPrisma;
}
