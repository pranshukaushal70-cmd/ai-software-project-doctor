# syntax=docker/dockerfile:1
#
# Production images for Project Doctor (Phase 10). One Dockerfile, three runtime targets:
#   web      Next.js standalone server (non-root, no dev dependencies, app files read-only)
#   worker   BullMQ worker: analysis pipeline, planner and code engine (non-root; git and the
#            Docker CLI for the optional sandbox; it has no Docker access unless the operator
#            mounts the socket, see docker-compose.sandbox.yml and docs/deployment.md)
#   migrate  one-shot `prisma migrate deploy` (only @pd/db's dependencies, incl. the Prisma CLI)
#
# Base images are pinned by digest. node:24-slim is the same image the sandbox runs tests in.
ARG NODE_IMAGE=node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG DOCKER_CLI_IMAGE=docker:29-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /app

# ---------------------------------------------------------------- manifests
# Only the manifests, so dependency layers are rebuilt only when dependencies change.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/agent/package.json packages/agent/
COPY packages/analyzer/package.json packages/analyzer/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/reports/package.json packages/reports/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/
COPY benchmarks/package.json benchmarks/

# ---------------------------------------------------------------- all dependencies (build, migrate)
FROM manifests AS deps
# `prisma generate` runs on install and needs the schema; the generated client is also committed.
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
RUN npm ci

# ---------------------------------------------------------------- web build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
ENV NODE_ENV=production NEXT_OUTPUT=standalone
RUN npm run build

# ---------------------------------------------------------------- worker production dependencies
FROM manifests AS worker-deps
# Install scripts are skipped: the generated Prisma client is committed (its generator is a dev
# dependency) and the analyzer uses the tree-sitter grammars' .wasm files, not their native bindings.
RUN npm ci --omit=dev --ignore-scripts --workspace @pd/worker

# ---------------------------------------------------------------- runtime: web
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 WORKSPACE_DIR=/data/workspace
# Application files stay owned by root (read-only for the app user); only the upload
# directory and Next.js's cache are writable.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
RUN mkdir -p /data/workspace /app/apps/web/.next/cache \
 && chown node:node /data/workspace /app/apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------- runtime: worker
FROM base AS worker
# git: hardened clones and exact-commit fetches. The Docker CLI is used only when the
# sandbox is enabled and the operator has given this container a Docker socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=worker-deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
# The demo project analysed for "Try the demo project" (packages/engine resolves demo/storefront).
COPY demo/storefront demo/storefront
ENV NODE_ENV=production WORKSPACE_DIR=/data/workspace DOCKER_CONFIG=/tmp/.docker
RUN mkdir -p /data/workspace && chown node:node /data/workspace
USER node
CMD ["node_modules/.bin/tsx", "apps/worker/src/index.ts"]

# ---------------------------------------------------------------- migrate dependencies
FROM manifests AS migrate-deps
# Only @pd/db and its dependencies, including the Prisma CLI (a dev dependency); its install
# scripts run (engines, and `prisma generate`, which needs the schema).
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
RUN npm ci --workspace @pd/db

# ---------------------------------------------------------------- one-shot: migrate
FROM base AS migrate
COPY --from=migrate-deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/db packages/db
WORKDIR /app/packages/db
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]
