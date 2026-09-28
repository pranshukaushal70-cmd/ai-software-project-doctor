import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// The single .env file lives at the monorepo root.
config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // `prisma generate` does not connect, so a missing URL is only fatal for migrate/studio.
    url: process.env.DATABASE_URL ?? "postgresql://unset@localhost:5432/unset",
  },
});
