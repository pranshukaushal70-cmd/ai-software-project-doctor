# Deployment (Phase 10)

Project Doctor ships as three images built from one [Dockerfile](../Dockerfile) and a compose file that runs them next
to PostgreSQL and Redis. This page covers building and running them, migrations, configuration, and the one decision
that changes the security model: giving the worker Docker access for the sandbox.

## Images

| Target | Runs | Contents | User |
|---|---|---|---|
| `web` | `node apps/web/server.js` (Next.js standalone server) | The traced production server only; no dev dependencies, no source of other apps | `node` (uid 1000) |
| `worker` | `tsx apps/worker/src/index.ts` (analysis pipeline, planner, code engine) | Production dependencies, the TypeScript sources of the packages it uses, `git`, the Docker CLI (used only when the sandbox is on) and `demo/storefront` | `node` |
| `migrate` | `prisma migrate deploy`, once | All dependencies (the Prisma CLI is a dev dependency) and `packages/db` | `node` |

- Base images are pinned by digest (`node:24-slim`, the image the sandbox also uses; `docker:29-cli` for the CLI binary
  only). Debian, not Alpine: `@node-rs/argon2` ships glibc binaries.
- Application files are owned by root and read-only for the app user. Compose additionally runs every container with a
  read-only root filesystem, `cap_drop: [ALL]` and `no-new-privileges`; only `/tmp`, the shared workspace volume and the
  Next.js cache are writable.
- `.dockerignore` keeps `.env*`, `.git`, `node_modules` and build output out of the build context: no secret is ever
  baked into an image. Credentials reach the containers as environment variables at run time.
- The worker runs TypeScript with `tsx`, as in development (every package exports `.ts` sources). This costs some
  start-up time and image size; bundling the worker is a possible later optimisation.
- `web` has a `HEALTHCHECK` against `GET /api/health` (database and Redis reachable; it reports only `ok`/`unavailable`).

## Running with compose

```bash
node scripts/setup-env.mjs                 # .env with a random JWT_SECRET and database password
docker compose --profile app up -d --build # postgres, redis, migrate (once), web, worker
open http://localhost:3000
```

`npm run services:up` still starts only PostgreSQL and Redis for local development; the application services are in the
`app` profile so they never start by accident.

Start order: `migrate` waits for a healthy PostgreSQL and must **exit successfully** before `web` and `worker` start
(`service_completed_successfully`), so the application never runs against an unmigrated schema. A failed migration
leaves the stack stopped with the error in `docker compose logs migrate`.

The web port is published on `127.0.0.1` only (`WEB_PORT`, default 3000). Put a TLS-terminating reverse proxy in front
for anything beyond the local machine and set `APP_URL` to the public origin: in production the session cookie is
`Secure` (browsers keep it over plain http only for `localhost`) and every POST is checked against `APP_URL`'s origin.
Set `TRUST_PROXY=true` only behind a proxy that overwrites `X-Forwarded-For` (rate limits key on the client address).
Without it, forwarding headers are ignored and the per-IP limits on login and sign-up apply to all clients together
([security.md](security.md#rate-limiting)).

Uploads go to the `workspace` volume, shared by `web` (writes archives) and `worker` (reads and keeps them for the code
engine); both run as uid 1000, which owns the volume.

## Configuration

The containers read the same variables as a local installation ([README](../README.md#environment-variables)); compose
passes them from `.env` or the shell. Required: `POSTGRES_PASSWORD`, `JWT_SECRET`. `ANTHROPIC_API_KEY` is optional and
read from the environment only; it is never written into an image, a file in the container or a log.

## Sandbox Docker access

By default no container gets Docker access, the worker runs with `SANDBOX_ENABLED=false`, and **no repository code ever
runs**: code-engine runs end with a diff for review.

To let the worker run approved tests in sandbox containers, add the opt-in override:

```bash
export DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)   # Linux; Docker Desktop: 0
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml --profile app up -d --build
```

[docker-compose.sandbox.yml](../docker-compose.sandbox.yml) sets `SANDBOX_ENABLED=true`, mounts the Docker socket into
the worker only, and adds the socket's group to the worker's unprivileged user (`group_add`); the worker still does not
run as root. The network-enabled install step stays off unless `SANDBOX_INSTALL_ENABLED=true` is also set, and each run
still needs the user's approval of the exact command (and a separate approval for the install step).

**What this costs.** The Docker socket is an API with full control of the Docker engine. Whoever controls the worker
process can start a privileged container, mount the host's root filesystem and so become root on the Docker host. A
read-only mount does not help (the socket is not a file being written). Mounting it moves the worker into the host's
trust boundary. Mitigations, in order of effect:

1. Run the worker (or the whole stack) on a **dedicated VM or host** that holds nothing else of value.
2. Use **rootless Docker**, so "root on the engine" is an unprivileged host user.
3. Install **gVisor** and set `SANDBOX_RUNTIME=runsc`, so test containers do not share the host kernel directly.
4. Keep the install step off unless needed; its network access is not restricted to the package registries.

**What does not change.** Repository code still runs only in per-command containers with `--network none` (except the
approved install step), a read-only root filesystem, a non-root user, all capabilities dropped, `no-new-privileges`,
process/memory/CPU/time limits, no host directory and no Docker socket ([code-engine.md](code-engine.md#sandbox)). The
worker copies the workspace into a per-run volume with `docker cp`; host paths are never mounted into sandbox containers,
which is why the worker can drive the sandbox from inside its own container without path translation.

**Alternatives considered.** Docker-in-Docker needs `--privileged`, which is worse than the socket. A socket-filtering
proxy cannot help much: the sandbox needs to create containers, volumes and copy files, which is exactly the
dangerous part of the API.

## Database migrations

- In compose, the `migrate` service applies pending migrations on every `up`; it is idempotent.
- Elsewhere: `docker compose run --rm migrate`, or `npm run db:deploy` with `DATABASE_URL` set.
- CI applies every migration to an empty PostgreSQL and checks that the result matches `schema.prisma`
  (`prisma migrate diff --exit-code`), so a schema change without a migration fails the build ([ci.md](ci.md)).

## Operations

| Task | Command |
|---|---|
| Status and health | `docker compose ps` (web shows `healthy`), `curl -s localhost:3000/api/health` |
| Logs | `docker compose logs -f web worker` (structured JSON; no task text, prompts, file contents or keys) |
| Upgrade | `git pull && docker compose --profile app up -d --build` (migrations run first) |
| Back up | `docker compose exec postgres pg_dump -U doctor project_doctor > backup.sql` |
| Stop / remove data | `docker compose --profile app down` / add `--volumes` to delete the database and uploads |

## Known limitations

- Images are built locally; no registry publishing or image signing yet.
- The worker image carries TypeScript sources and `tsx` rather than a bundle.
- No TLS termination in the stack; bring your own reverse proxy.
- With the sandbox override the worker is root-equivalent on the Docker host (above).
