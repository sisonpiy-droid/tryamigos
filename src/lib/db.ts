import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/* Prisma 7 connects through a driver adapter rather than its own engine
   binary, which is what lets this run on serverless without bundling one. */

const makeClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

/* Next.js hot-reload re-evaluates modules on every edit. Without this the dev
   server opens a new connection pool per reload and exhausts Postgres within
   a few minutes of editing. */
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof makeClient> };

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
