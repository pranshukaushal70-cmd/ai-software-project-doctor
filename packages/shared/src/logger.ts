import pino, { type Logger } from "pino";

/**
 * Key paths that must never reach log output. Values are replaced with "[REDACTED]".
 * Secrets found inside repositories are masked before they reach any logger,
 * this is a second line of defence for request/config objects.
 */
const REDACT_PATHS = [
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "headers.cookie",
  "*.headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
];

let root: Logger | undefined;

function rootLogger(): Logger {
  if (!root) {
    root = pino({
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: process.env.SERVICE_NAME ?? "project-doctor" },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return root;
}

export function createLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger().child({ component, ...bindings });
}

export type { Logger };
