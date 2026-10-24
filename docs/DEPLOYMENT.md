# Deployment readiness

Status as of Phase 12. **Not deployed anywhere yet.** The Docker image below was written but **not built or run** in this environment (Docker Desktop wasn't running). Everything else was verified locally.

## Requirements

| | |
|---|---|
| Runtime | Node.js ≥ 22 (developed on 24); `npm ci` from `server/package-lock.json` |
| Database | MongoDB 8 (local service, container, or Atlas). Single node works; a replica set is recommended for production. |
| Storage | `STORAGE_PROVIDER=local` writes to a directory; mount a persistent volume. Cloud storage needs a new adapter (`server/src/storage/index.ts`). |
| AI (optional) | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`. Without it, complaints go to manual triage. |
| Proxy | TLS terminated by a reverse proxy or load balancer; set `TRUST_PROXY` to the number of hops. |

## Configuration (production)

Startup refuses to run with unsafe or invalid settings and lists the offending variable names:

- **Secrets:** `JWT_SECRET` must be ≥ 32 random characters; placeholder-looking values are rejected.
- **CORS and cookies:** `CORS_ORIGINS` is required and must be https. `COOKIE_SECURE` can't be `false`. `COOKIE_SAMESITE=none` requires secure cookies.
- **AI:** `ANTHROPIC_API_KEY` is required when `AI_PROVIDER=anthropic`.
- **Error detail:** `NODE_ENV=production` hides error details from clients and turns off automatic index creation.

Full list: `server/.env.example` and `server/README.md`. Keep secrets in the platform's secret store, never in the image.

## Build and run

```bash
# Without Docker
cd server
npm ci
npm run build
npm run db:sync-indexes:prod                 # once per release (indexes changed in Phases 7–10)
NEW_USER_PASSWORD='…' npm run user:create:prod -- --email admin@city.example --name Admin --role PLATFORM_ADMIN   # first admin, once
NODE_ENV=production node dist/server.js

# With Docker (not verified here)
docker build -t civicfix-api server/
docker run -p 4000:4000 --env-file server/.env -v civicfix-uploads:/app/uploads civicfix-api
```

The image runs as the non-root `node` user, contains only production dependencies, and has a `HEALTHCHECK` on `/health/live`.

## Health and operations

| Probe | Use |
|---|---|
| `GET /health/live` | Liveness: the process is up (no database call) |
| `GET /health/ready` | Readiness: MongoDB answers a ping and the server isn't shutting down. Use it for load-balancer routing. |

- **Shutdown:** on `SIGTERM`/`SIGINT` the server stops accepting connections, lets requests finish (`SHUTDOWN_TIMEOUT_MS`), stops the AI job runner, then closes MongoDB.
- **Logs:** JSON on stdout (pino), with `requestId` on every line; secrets are redacted. Ship stdout to the log platform.
- **Background jobs:** AI and photo-check jobs live in MongoDB and survive restarts. Only one instance should run jobs at scale. Leases prevent double processing, but there is no cross-instance scheduling.

## Scaling notes

- **Rate limits are in memory, per instance.** With several instances, use a shared store (e.g. Redis) for `express-rate-limit`.
- **Uploaded files:** local storage only works with one instance, or a shared volume.
- **Multi-step changes:** use a replica set and wrap multi-document changes in transactions. They currently rely on ordered writes plus undo steps (see `docs/api/ASSIGNMENTS_WORK_ORDERS.md` §5).

## Pre-launch checklist

- [ ] `npm ci && npm run typecheck && npm test && npm run build` pass on the release commit.
- [ ] `npm audit` reviewed (0 known vulnerabilities at Phase 12).
- [ ] Production env set; `JWT_SECRET` freshly generated; `.env` not in the image or repository.
- [ ] `npm run db:sync-indexes:prod` run against the production database.
- [ ] First platform admin created with `user:create:prod`.
- [ ] One live AI classification verified (if `AI_PROVIDER=anthropic`).
- [ ] Policy values approved: target times, auto-assignment, auto-approval (off), dispute window.
- [ ] Backups for MongoDB and the uploads volume.
