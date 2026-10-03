import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "engine", environment: "node", env: { LOG_LEVEL: "silent" } },
});
