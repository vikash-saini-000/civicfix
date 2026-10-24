# CivicFix server

**Status:** Phase 2. Models, the Express foundation, the MongoDB connection, health checks, logging, error handling and graceful shutdown exist. There are **no product APIs yet** (no auth, complaints, AI, etc.).

Stack: Node 22+ (ESM), TypeScript, Express 5, Mongoose 9, pino, Vitest.

## Run locally

Requires a running MongoDB (local 8.0 service is fine).

```bash
cd server
npm install
cp .env.example .env      # then edit values if needed
npm run dev               # tsx watch, http://localhost:4000
```

| Script | Does |
|---|---|
| `npm run dev` | Run from source with reload |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Run all tests |
| `npm run db:sync-indexes` | Create/update model indexes (needed in production, where auto-indexing is off). It also drops indexes no longer in the schemas. |

## Environment variables

`.env` is read from the working directory if it exists; real environment variables take precedence. Invalid or missing values stop startup with a list of problems (names only, never values).

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | **required** | `mongodb://` or `mongodb+srv://` connection string. Never logged. |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `HOST` / `PORT` | `0.0.0.0` / `4000` | HTTP listen address |
| `CORS_ORIGINS` | none | Comma-separated exact origins (e.g. `http://localhost:5173`). `*` is rejected. Required and https-only in production. |
| `JSON_BODY_LIMIT` | `100kb` | Max JSON body, 1kb–1mb |
| `LOG_LEVEL` | `info` (`silent` in test) | pino level |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Time in-flight requests get during shutdown |
| `DB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | How long startup waits for MongoDB |

## Startup, database and shutdown

1. `src/server.ts` loads `.env`, validates config, and creates the logger.
2. Connects to MongoDB (`src/config/database.ts`). One attempt shared by concurrent callers; queries are **not buffered** while disconnected, so they fail fast. If MongoDB isn't reachable within `DB_SERVER_SELECTION_TIMEOUT_MS`, the process logs a sanitized error and **exits with code 1**; there is no startup retry loop, so a process manager or the developer restarts it.
3. Only then does the HTTP server listen. Indexes are built on connect outside production.
4. If MongoDB drops later, the driver reconnects on its own. Meanwhile `/health/ready` returns 503 and every `/api/v1` request gets `503 SERVICE_UNAVAILABLE`.
5. On `SIGINT`/`SIGTERM` (Ctrl+C): readiness turns 503, the server stops accepting connections, in-flight requests get `SHUTDOWN_TIMEOUT_MS` to finish (then sockets are force-closed and the exit code is 1), then MongoDB is disconnected. Repeated signals don't repeat the work.

`src/app.ts` builds the Express app without listening or connecting, so tests can use it directly. Middleware order: request ID → request log → helmet → CORS → JSON parser → `/health` → `/api/v1` (database guard) → 404 → error handler.

## Endpoints (infrastructure only)

| Method and path | Response |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}`. Never touches the database. |
| `GET /health/ready` | `200 {"status":"ready","checks":{"database":"up"}}`, or `503 {"status":"not_ready","checks":{"database":"down"}}` when MongoDB is disconnected or doesn't answer a ping within 1 s, or while shutting down. |
| anything else | `404` error body (below) |

`/api/v1` is the versioned namespace for product routes; it has none yet.

**Error body**, for every error:

```json
{ "error": { "code": "NOT_FOUND", "message": "No route for GET /x.", "requestId": "…" } }
```

Codes so far: `NOT_FOUND` 404, `INVALID_JSON` 400, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_ENCODING` 415, `SERVICE_UNAVAILABLE` 503 (with `Retry-After: 5`), `INTERNAL_ERROR` 500. Unexpected errors never return their message or stack in production or test; in development the 500 message includes the sanitized error message.

## Logging and request IDs

- Structured JSON logs (pino) with `time`, `level`, `service`, `env` and, per request, `requestId`. One line per request: method, path (without query string), status, duration.
- Authorization headers, cookies, and password, token, secret and URI fields are redacted. Request bodies are never logged.
- **Request ID policy:** an incoming `X-Request-Id` is kept if it is 8–64 characters of `A-Z a-z 0-9 . _ -`; otherwise a UUID is generated. It is returned in the `X-Request-Id` response header and in every error body.

## Tests

```bash
npm test
```

Database tests start throwaway in-memory MongoDB servers (`mongodb-memory-server-core`), never the local service or a shared database. To use the installed binary instead of downloading one:

```bash
MONGOMS_SYSTEM_BINARY="C:/Program Files/MongoDB/Server/8.0/bin/mongod.exe" npm test
```

| File | Covers |
|---|---|
| `tests/validation.test.ts` | Model validation (no DB) |
| `tests/database.test.ts` | Indexes, uniqueness, geo query, append-only audit log |
| `tests/env.test.ts` | Config validation and redaction |
| `tests/app.test.ts` | Health, 404, malformed or oversized JSON, safe errors, request IDs, CORS, headers, log redaction |
| `tests/lifecycle.test.ts` | DB connection failure, single connect, readiness up/down, graceful shutdown and timeout |

## Transactions

MongoDB transactions need a replica set. A standalone local MongoDB (like the default Windows service) works for everything in this phase, but multi-document transactions planned for later phases need either a single-node replica set (`replication.replSetName: rs0` in `mongod.cfg`, then `rs.initiate()`, and `?replicaSet=rs0` in `MONGODB_URI`) or Atlas.

## Models (`src/models/`)

| Model | Holds |
|---|---|
| `User` | Name, normalized unique email, password hash (hidden by default), `platformRole` (`CITIZEN` / `PLATFORM_ADMIN`), account status |
| `Department` | Name (case-insensitive unique), description, handled categories, active flag |
| `DepartmentMembership` | User ↔ department, role (`MEMBER` / `MANAGER`), active state; unique per user + department |
| `Complaint` | Citizen's original report, GeoJSON location, selected vs confirmed category, priority, status, public status history, duplicate link |
| `WorkOrder` | Operational work for one complaint: department, assignee, assignment source/reason, manager review, deadlines, progress, blocker, completion notes |
| `AIAnalysis` | Versioned, structured AI output (triage, resolution verification, media authenticity) plus the human review of it |
| `Evidence` | Metadata and object-storage key for every uploaded file (complaint photos, resolution evidence, dispute evidence) |
| `AuditLog` | Append-only record of actor, action, target, outcome, reason, correlation ID and safe change summary |
| `Notification` | Recipient, type, related resource, safe text, delivery state, retry counters, dedupe key |
| `Dispute` | Citizen challenge to a resolution, with an immutable snapshot of the disputed resolution and the manager decision |
| `Feedback` | Citizen 1–5 rating and comment; one per citizen per complaint |

Enums are in `src/models/enums.ts`. Statuses, categories and priorities match `client/src/lib/domain.ts`.

## Schema decisions

- **Roles:** the platform role is on `User`. Department roles live only in `DepartmentMembership`, so one user can be a member of one department and a manager of another. A department member reporting a pothole is still a citizen for that complaint.
- **Complaint vs work-order status:** kept separate, as the blueprint requires. Work orders have their own lifecycle starting at `PENDING_ASSIGNMENT`. Transition rules belong to the workflow phase, not to the models.
- **One work order per complaint** (unique index). Reassignment and reopening update it instead of creating a second one.
- **Duplicates:** `Complaint.duplicateOf` points at the canonical complaint and records who or what linked it. Nothing is deleted or overwritten. A complaint cannot link to itself.
- **Files:** all file metadata lives in `Evidence`, and binaries go to object storage. Complaints don't keep a separate media array; photos are found with `Evidence.find({ complaint, purpose: 'COMPLAINT_REPORT' })`.
- **Status history:** `Complaint.statusHistory` is the citizen-facing timeline (status, time, public note). Internal detail goes to `AuditLog`. The complaint service must update `status` and `statusHistory` in the same write.
- **AI output** is stored separately from decisions. Final category, priority, department and assignment live on `Complaint` / `WorkOrder`. No prompts, raw responses or keys are stored.
- **AuditLog** blocks Mongoose update, replace and delete operations and rejects change entries for sensitive field names (password, token, secret, hash and similar).
- **Model-level invariants only:** e.g. a rejected complaint needs a reason, a blocked work order needs a reason and next action, assigned statuses need an assignee, and a decided dispute needs a decision record. No business workflows run in hooks.
- **Upload limits:** JPEG, PNG and WebP images up to 10 MB; MP4 video up to 50 MB.
- **No soft delete.** Users, departments and memberships are deactivated through their status or active fields.
