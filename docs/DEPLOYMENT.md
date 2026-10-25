# Deployment readiness

Status as of Phase 12. **Not deployed anywhere yet.** The Docker image below was written but **not built or run** in this environment (Docker Desktop wasn't running). Everything else was verified locally.

## Requirements

| | |
|---|---|
| Runtime | Node.js ≥ 22 (developed on 24); `npm ci` from `server/package-lock.json` |
| Database | MongoDB 8 (local service, container, or Atlas). Single node works; a replica set is recommended for production. |
| Storage | `STORAGE_PROVIDER=cloudinary` for production (required on Vercel). `local` writes to a directory and needs a persistent volume. |
| AI (optional) | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`. Without it, complaints go to manual triage. |
| Proxy | TLS terminated by a reverse proxy or load balancer; set `TRUST_PROXY` to the number of hops. |

## Vercel setup (two projects), Cloudinary storage, Turnstile

```
Browser ──> frontend project  civic-fix-system.vercel.app   (Root Directory: client)
              ├── static app (dist)
              └── /api/*  ──> api/proxy.js ──> API project  civic-fix-api.vercel.app   (Root Directory: server)
                                                   └── api/index.mjs (Express) ──> MongoDB Atlas
Browser ──(signed upload)──> Cloudinary staging ──> API downloads, checks, stores privately
```

Frontend and API are **separate Vercel projects** from the same repository. The frontend's `/api/*` requests go through a small proxy function (`client/api/proxy.js`), so the browser only ever talks to the frontend's own domain:

- The refresh cookie stays first-party (`COOKIE_SAMESITE=lax`). Two `*.vercel.app` domains count as different sites, and Safari and Brave block cross-site cookies, so calling the API domain directly would log users out on every reload.
- No CORS preflights.
- The proxy passes the visitor's IP with a shared secret (`PROXY_SHARED_SECRET`). Without that, every visitor would appear to come from the proxy and share one set of per-IP limits (e.g. 10 registrations an hour for everyone).

### What changes on serverless (and how it's handled)

| Vercel limit | Handling |
|---|---|
| 4.5 MB per request **and** response | Files never pass through the API or the proxy: browsers upload to Cloudinary with a one-off signature, and view files through 15-minute signed links. |
| Nothing runs between requests | After each response the API keeps processing queued AI/privacy jobs (`waitUntil`, up to ~250 s). A daily cron finishes leftovers. |
| No ffmpeg on the image | `@ffmpeg-installer` / `@ffprobe-installer` binaries are bundled (`includeFiles` in `server/vercel.json`). |
| Hobby cron runs once a day | SLA-overdue alerts are recorded daily (hourly needs Pro). |
| Instances come and go | MongoDB connects once per instance. Rate limits are per instance (see Risks). |

### 1a. API project (create first)

Vercel → Add New → Project → import the repo. **Root Directory: `server`**. Project name e.g. `civic-fix-api` (gives `civic-fix-api.vercel.app`). `server/vercel.json` sets the build, function and cron settings. Node.js 22 or newer.

Environment variables (*Production*):

```
NODE_ENV=production
MONGODB_URI=mongodb+srv://…                       # Atlas; allow Vercel (0.0.0.0/0 on free Atlas)
JWT_SECRET=<48+ random chars>
CORS_ORIGINS=https://civic-fix-system.vercel.app  # the FRONTEND origin (+ custom domain)
TRUST_PROXY=1
PROXY_SHARED_SECRET=<32+ random chars>            # same value as in the frontend project
COOKIE_SAMESITE=lax
STORAGE_PROVIDER=cloudinary
CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
CLOUDINARY_FOLDER=civicfix
CAPTCHA_PROVIDER=turnstile
TURNSTILE_SECRET_KEY=<secret key>
TURNSTILE_HOSTNAMES=civic-fix-system.vercel.app   # the FRONTEND hostname (+ custom domain)
CRON_SECRET=<32+ random chars>
EVIDENCE_CAPTURE=camera
# plus AI_* settings if AI is on
```

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

Before the first real use, from your machine against the production database: `npm run db:sync-indexes:prod`, then create the first admin with `user:create:prod` (see *Build and run*). `autoIndex` is off in production.

### 1b. Frontend project

Add New → Project → import the **same** repo again. **Root Directory: `client`**. Project name `civic-fix-system` (gives `civic-fix-system.vercel.app`, if the name is free). Framework: Vite (set by `client/vercel.json`).

Environment variables (*Production*):

```
API_ORIGIN=https://civic-fix-api.vercel.app   # the API project's URL, no trailing slash
PROXY_SHARED_SECRET=<same value as the API>
VITE_TURNSTILE_SITE_KEY=<site key>            # read at build time
```

Leave `VITE_CIVICFIX_API_BASE_URL` unset (the app calls its own `/api`, which the proxy forwards).

Order matters only for the URLs: deploy the API first to learn its URL, then set `API_ORIGIN`. If you rename the frontend later, update `CORS_ORIGINS` and `TURNSTILE_HOSTNAMES` on the API and redeploy it.

**Preview deployments** get their own URLs, which are not in `CORS_ORIGINS` / `TURNSTILE_HOSTNAMES`. Give the *Preview* environment of both projects their own database, Cloudinary folder and Turnstile hostnames, or leave Preview variables unset. Never reuse production secrets there.

### 2. File storage: Cloudinary

1. Dashboard → copy the *API environment variable* (`cloudinary://…`) into `CLOUDINARY_URL`.
2. Settings → Security: keep *Restricted media types* defaults; nothing needs to be public. Every file is uploaded as an **authenticated** asset, so plain Cloudinary URLs return 401.

Flow: `POST /api/v1/evidence/uploads` returns a signature for one upload into `<folder>/staging/<uuid>` (allowed formats jpg/png/webp or mp4/mov/webm). The browser posts the file to Cloudinary, then calls `POST /evidence/check-upload` or `POST /complaints/:id/evidence/from-upload` with the returned token. The API downloads the staged file and runs every existing check (type from bytes, size, camera stamp, AI/edit screening, WebM→MP4), stores it under its final key and deletes the staged copy. Tokens are bound to the user and expire in 2 hours; the daily cron deletes staged files older than 24 hours.

Viewing: `GET /evidence/:id/link` applies the same access rules and audit as `/content` and returns a signed Cloudinary download URL valid for 15 minutes. Privacy copies (faces/plates blurred) are served to everyone except the uploader, as before.

Free plan fit: 25 monthly credits (1 credit ≈ 1 GB storage or 1 GB bandwidth); max 10 MB per image and 100 MB per video, above the app's own 10 MB / 50 MB limits.

### 3. Human check: Cloudflare Turnstile

1. Cloudflare dashboard → Turnstile → Add widget. Hostname: the **frontend** domain (`civic-fix-system.vercel.app`, plus any custom domain). Mode: Managed.
2. Frontend project: `VITE_TURNSTILE_SITE_KEY` (site key). API project: `CAPTCHA_PROVIDER=turnstile`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_HOSTNAMES`. Redeploy the frontend so its build picks up the site key.

Register, login and new complaints then need a token in the `X-Turnstile-Token` header. The API verifies each one with Siteverify (valid, unused, our hostname, exactly that action: `register`, `login` or `complaint`) and refuses if Siteverify can't be reached. Turn both sides on together.

### 4. After the first deploy

- `GET https://civic-fix-api.vercel.app/health/ready` returns 200, and `https://civic-fix-system.vercel.app/api/v1/auth/me` returns 401 (proxy reaches the API).
- Register (Turnstile shows), file a complaint with a phone photo and a short video, open it as staff: the image appears (blurred copy) and the video plays.
- API project → Logs: the request IP is your own public IP, not a Vercel address (confirms `PROXY_SHARED_SECRET` matches in both projects).
- API project → Settings → Cron Jobs: run the maintenance job once manually; it returns 200.

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
- **Uploaded files:** use Cloudinary with several instances (always on Vercel); local storage only works with one instance or a shared volume.
- **Multi-step changes:** use a replica set and wrap multi-document changes in transactions. They currently rely on ordered writes plus undo steps (see `docs/api/ASSIGNMENTS_WORK_ORDERS.md` §5).

## Pre-launch checklist

- [ ] `npm ci && npm run typecheck && npm test && npm run build` pass on the release commit.
- [ ] `npm audit` reviewed (0 known vulnerabilities at Phase 12).
- [ ] Production env set; `JWT_SECRET` freshly generated; `.env` not in the image or repository.
- [ ] `npm run db:sync-indexes:prod` run against the production database.
- [ ] First platform admin created with `user:create:prod`.
- [ ] One live AI classification verified (if `AI_PROVIDER=anthropic`).
- [ ] Policy values approved: target times, auto-assignment, auto-approval (off), dispute window.
- [ ] Backups for MongoDB (and the uploads volume if `STORAGE_PROVIDER=local`).
- [ ] Turnstile on both sides (`VITE_TURNSTILE_SITE_KEY` and `CAPTCHA_PROVIDER=turnstile`); one register and one complaint tested on the live site.
- [ ] Cloudinary: a plain `res.cloudinary.com/...` URL for an uploaded file returns 401 (assets are private); photo and video upload and view tested on the live site.
- [ ] `CRON_SECRET` set; the maintenance cron ran once successfully.
- [ ] API logs show real visitor IPs (confirms `PROXY_SHARED_SECRET` is the same in both projects).
