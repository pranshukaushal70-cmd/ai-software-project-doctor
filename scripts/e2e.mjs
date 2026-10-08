#!/usr/bin/env node
// Drives the end-to-end stack (docker-compose.e2e.yml) and the Playwright suite.
//
//   node scripts/e2e.mjs up      build the images and start the stack, wait until healthy
//   node scripts/e2e.mjs test    run the Playwright specs against it (args are passed on)
//   node scripts/e2e.mjs reset   clear the stack's rate-limit counters (done before every `test`)
//   node scripts/e2e.mjs logs    print the web, worker and stub logs
//   node scripts/e2e.mjs down    stop the stack and delete its volumes (fresh data next time)
//
// E2E_SANDBOX=1 adds docker-compose.sandbox.yml: the worker gets the Docker socket and the
// specs run the fixture's tests in the sandbox (read docs/deployment.md first). The stack
// always uses e2e/stack.env, never the developer's .env.
//
// PD_STACK=eval starts the real-model evaluation stack instead (docker-compose.eval.yml,
// project "pd-eval"): the real Anthropic API with ANTHROPIC_API_KEY from the environment,
// for `npm run bench:agent` (docs/benchmark.md). The default stack (project "pd-e2e") uses
// the model stub and can never reach the real API.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = process.env.E2E_SANDBOX === "1";
const stack = process.env.PD_STACK === "eval" ? "eval" : "e2e";
const [command = "up", ...rest] = process.argv.slice(2);

const env = { ...process.env };
if (sandbox && !env.DOCKER_SOCKET_GID) {
  // The worker runs as an unprivileged user and reaches the socket through its group.
  // Docker Desktop's socket (inside its VM) is root-owned, group 0.
  try {
    env.DOCKER_SOCKET_GID = String(statSync(env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock").gid);
  } catch {
    env.DOCKER_SOCKET_GID = "0";
  }
}

// Compose interpolates every file for every command: `down` and `logs` of the evaluation
// stack must work without the key, which only `up` hands to the containers.
if (stack === "eval" && command !== "up" && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = "not-needed-for-this-command";

const files = ["docker-compose.yml", `docker-compose.${stack}.yml`, ...(sandbox ? ["docker-compose.sandbox.yml"] : [])];
const services = stack === "e2e" ? ["migrate", "web", "worker", "model-stub"] : ["migrate", "web", "worker"];
const composeWith = (stdio, args) => {
  const full = ["compose", "-p", `pd-${stack}`, "--env-file", "e2e/stack.env", ...files.flatMap((f) => ["-f", f]), "--profile", "app", ...args];
  const r = spawnSync("docker", full, { cwd: root, env, stdio });
  return r.status ?? 1;
};
const compose = (...args) => composeWith("inherit", args);

// The web tier's rate limits (sign-ups: 5 per hour per client address) would stop a second
// run against the same stack. Only this throwaway stack's Redis is touched, and only the
// limiter keys (rl:*), never the job queues.
const resetLimits = () =>
  composeWith(["ignore", "ignore", "inherit"], ["exec", "-T", "redis", "redis-cli", "EVAL", "local n = 0 for _, k in ipairs(redis.call('KEYS', 'rl:*')) do redis.call('DEL', k) n = n + 1 end return n", "0"]);

let status;
switch (command) {
  case "up":
    status = compose("up", "-d", "--build", "--wait", "--wait-timeout", "300", ...rest);
    if (status !== 0) compose("logs", "--no-color", "--tail", "200", ...services);
    break;
  case "down":
    status = compose("down", "--volumes", "--remove-orphans", ...rest);
    break;
  case "reset":
    status = resetLimits();
    break;
  case "logs":
    status = compose("logs", "--no-color", ...(rest.length ? rest : services.slice(1)));
    break;
  case "test": {
    if (stack !== "e2e") {
      console.error("The Playwright specs run against the stub stack only; use `npm run bench:agent` with PD_STACK=eval.");
      status = 2;
      break;
    }
    if (resetLimits() !== 0) {
      status = 1;
      break;
    }
    const r = spawnSync("npx", ["playwright", "test", ...rest], { cwd: path.join(root, "e2e"), env, stdio: "inherit", shell: process.platform === "win32" });
    status = r.status ?? 1;
    break;
  }
  default:
    console.error(`Unknown command "${command}". Use up, test, reset, logs or down.`);
    status = 2;
}
process.exit(status);
