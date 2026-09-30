import path from "node:path";
import { defineProject } from "vitest/config";

export default defineProject({
  // tsconfig keeps `jsx: "preserve"` for Next.js; tests compile JSX themselves.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      "server-only": path.resolve(import.meta.dirname, "test/server-only-stub.ts"),
    },
  },
  test: { name: "web", environment: "node", env: { LOG_LEVEL: "silent" }, include: ["**/*.test.ts"], exclude: ["node_modules", ".next"] },
});
