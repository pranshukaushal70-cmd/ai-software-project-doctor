import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "reports", environment: "node", env: { LOG_LEVEL: "silent" } },
});
