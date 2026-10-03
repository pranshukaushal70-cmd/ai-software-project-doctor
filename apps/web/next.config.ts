import path from "node:path";
import type { NextConfig } from "next";

// The monorepo keeps a single .env at the root; Next.js only looks in apps/web by default.
try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../.env"));
} catch {
  // No root .env (e.g. in containers, where variables come from the environment).
}

const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@pd/shared", "@pd/analyzer", "@pd/db", "@pd/agent"],
  serverExternalPackages: ["@node-rs/argon2", "pino", "bullmq", "ioredis", "pg", "@prisma/client", "@prisma/adapter-pg", "yauzl", "@anthropic-ai/sdk"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
