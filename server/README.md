# CivicFix server

**Status:** Phase 7. Models, the Express foundation, the MongoDB connection, health checks, logging, graceful shutdown, request validation, the response envelope, JWT authentication with role guards, user profiles, departments, memberships and complaint APIs (create, scoped list and read, manual classify and reject) and the AI analysis pipeline (classification, duplicate candidates, media-authenticity analyzer) exist. There are no work-order or evidence-upload APIs yet.

For client developers: [`API_CONVENTIONS.md`](../docs/api/API_CONVENTIONS.md), [`AUTHENTICATION.md`](../docs/api/AUTHENTICATION.md) [`USERS_DEPARTMENTS_MEMBERSHIPS.md`](../docs/api/USERS_DEPARTMENTS_MEMBERSHIPS.md) and [`COMPLAINTS.md`](../docs/api/COMPLAINTS.md).

Stack: Node 22+ (ESM), TypeScript, Express 5, Mongoose 9, zod 4, pino, Vitest.

## Run locally

Requires a running MongoDB (local 8.0 service is fine).

```bash
cd server
npm install
cp .env.example .env      # then set JWT_SECRET (see the comment in the file)
npm run dev               # tsx watch, http://localhost:4000
```

| Script | Does |
|---|---|
| `npm run dev` | Run from source with reload |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Run all tests |
| `npm run user:create` | Create an account outside public registration, e.g. the first `PLATFORM_ADMIN` (password from `NEW_USER_PASSWORD`) |
| `npm run db:sync-indexes` | Create/update model indexes (needed in production, where auto-indexing is off). It also drops indexes no longer in the schemas. |

## Environment variables

`.env` is read from the working directory if it exists; real environment variables take precedence. Invalid or missing values stop startup with a list of problems (names only, never values).

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | **required** | `mongodb://` or `mongodb+srv://` connection string. Never logged. |
| `JWT_SECRET` | **required** | Access-token signing key, at least 32 random characters. Placeholder-looking values are rejected. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime (60–3600) |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Session lifetime from sign-in (1–30) |
| `COOKIE_SECURE` | `true` in production, else `false` | Refresh cookie `Secure` flag. Can't be `false` in production. |
| `COOKIE_SAMESITE` | `lax` | `strict`, `lax` or `none` (`none` needs `COOKIE_SECURE=true`) |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `HOST` / `PORT` | `0.0.0.0` / `4000` | HTTP listen address |
| `CORS_ORIGINS` | none | Comma-separated exact origins (e.g. `http://localhost:5173`). `*` is rejected. Required and https-only in production. |
| `JSON_BODY_LIMIT` | `100kb` | Max JSON body, 1kb–1mb |
| `LOG_LEVEL` | `info` (`silent` in test) | pino level |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Time in-flight requests get during shutdown |
| `DB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | How long startup waits for MongoDB |
| `AI_PROVIDER` | `disabled` | `disabled` or `anthropic`; see [AI_ANALYSIS_PIPELINE.md](../docs/ai/AI_ANALYSIS_PIPELINE.md) |
| `ANTHROPIC_API_KEY` | none | Required when `AI_PROVIDER=anthropic`; never logged |
| `AI_MODEL` / `AI_TIMEOUT_MS` / `AI_MAX_ATTEMPTS` | `claude-opus-5-5` / `30000` / `3` | Model ID, per-call timeout, attempts per job |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the API (0–10). Set it when deployed behind one, so client IPs and rate limits are correct. |

## Startup, database and shutdown

1. `src/server.ts` loads `.env`, validates config, and creates the logger.
2. Connects to MongoDB (`src/config/database.ts`). One attempt shared by concurrent callers; queries are **not buffered** while disconnected, so they fail fast. If MongoDB isn't reachable within `DB_SERVER_SELECTION_TIMEOUT_MS`, the process logs a sanitized error and **exits with code 1**; there is no startup retry loop, so a process manager or the developer restarts it.
3. Only then does the HTTP server listen. Indexes are built on connect outside production.
4. If MongoDB drops later, the driver reconnects on its own. Meanwhile `/health/ready` returns 503 and every `/api/v1` request gets `503 SERVICE_UNAVAILABLE`.
5. On `SIGINT`/`SIGTERM` (Ctrl+C): readiness turns 503, the server stops accepting connections, in-flight requests get `SHUTDOWN_TIMEOUT_MS` to finish (then sockets are force-closed and the exit code is 1), then MongoDB is disconnected. Repeated signals don't repeat the work.

`src/app.ts` builds the Express app without listening or connecting, so tests can use it directly. Middleware order: request ID → request log → helmet → CORS → JSON parser → `/health` → `/api/v1` (database guard → JSON content-type check → feature routes) → 404 → error handler.

## Endpoints (infrastructure only)

| Method and path | Response |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}`. Never touches the database. |
| `GET /health/ready` | `200 {"status":"ready","checks":{"database":"up"}}`, or `503 {"status":"not_ready","checks":{"database":"down"}}` when MongoDB is disconnected or doesn't answer a ping within 1 s, or while shutting down. |
| anything else | `404` error body |

`/api/v1` is the versioned namespace for product routes; it has none yet.

## Authentication (summary)

Full contract: [`docs/api/AUTHENTICATION.md`](../docs/api/AUTHENTICATION.md).

- A 15-minute JWT access token goes in `Authorization: Bearer`. A 7-day rotating refresh token sits in an HttpOnly cookie, and only its SHA-256 hash is stored in `AuthSession`.
- `requireAuth(authService)` verifies the token, then loads the session, user and active memberships on **every** request. Logout, suspension and role changes therefore apply immediately.
- Passwords are hashed with Argon2id (`@node-rs/argon2`, OWASP parameters). Unknown-email logins still run a dummy verify, so timing doesn't reveal which accounts exist.
- Audit entries are written for `user.registered`, `auth.login_succeeded`, `auth.login_failed`, `auth.logout`, `auth.refresh_token_reused` and `user.provisioned`.

| Piece | File |
|---|---|
| Register / login / refresh / logout / authenticate | `src/auth/authService.ts` |
| Routes, request schemas, rate limits | `src/routes/auth.ts` |
| `requireAuth`, `requireRole`, `requireDepartmentRole`, `requireCsrfHeader` | `src/middleware/auth.ts` |
| Role names and `Principal` (`req.auth`) | `src/auth/roles.ts` |
| Tokens, password hashing, refresh cookie | `src/auth/tokens.ts`, `src/auth/password.ts`, `src/auth/cookies.ts` |
| Session model | `src/models/AuthSession.ts` |

## Users, departments, memberships

| Piece | File |
|---|---|
| Routes and request schemas | `src/routes/users.ts`, `src/routes/departments.ts` |
| Business rules and authorization per department | `src/services/users.ts`, `src/services/departments.ts`, `src/services/memberships.ts` |
| Audit helper | `src/services/audit.ts` |

Membership authority is computed in `authorityOver(principal, departmentId)`: platform admin, or manager of **that** department, else none. Revoking sets `status: INACTIVE`, and adding the user again reactivates the same record, so the unique `(user, department)` index still holds. No schema changes were needed in Phase 5.

## Complaints

| Piece | File |
|---|---|
| Routes and request schemas | `src/routes/complaints.ts` |
| Visibility, views, classify and reject | `src/services/complaints.ts` |
| Status transition table (all phases; later ones unreachable) | `src/policies/complaintLifecycle.ts` |
| Public ID sequence (`CF-YYYY-NNNNN`, atomic per year) | `src/models/Counter.ts` |

Access is resolved into the MongoDB query (`scope` + filters combined with `$and`); inaccessible complaints return 404. Transitions use a conditional update on the current status, so concurrent actions can't both apply.

## AI analysis

| Piece | File |
|---|---|
| Provider interface, output schemas, disabled provider | `src/ai/types.ts` |
| Claude adapter (only file importing the SDK) and prompts | `src/ai/anthropicProvider.ts`, `src/ai/prompts.ts` |
| DB-backed job runner (claim, lease, retry, sweep) | `src/services/analysis/runner.ts` |
| Duplicate search and text similarity | `src/services/analysis/duplicates.ts`, `textSimilarity.ts` |
| Media authenticity signals | `src/services/analysis/mediaAuthenticity.ts` |
| Summary, re-run and `analyzeEvidence` | `src/services/analysis/index.ts` |

`server.ts` starts the runner after the server starts listening and stops it on shutdown. `createApp` without an `analysis` dependency only queues jobs and runs nothing, which keeps tests deterministic. **After pulling Phase 7, run `npm run db:sync-indexes`** on existing databases: an `AIAnalysis` unique index changed.

## Writing routes (conventions)

Feature routers are mounted in `src/routes/api.ts`. Per route: `[rate limit] → requireAuth → requireRole / requireDepartmentRole → validate(...) → handler`. Identity comes only from `req.auth`.

```ts
const body = z.strictObject({ title: text(5, 120) });     // strict: unknown fields are a 400
router.post('/things', validate({ body }), async (req, res) => {
  const input = req.validated.body as z.infer<typeof body>;
  sendCreated(res, await createThing(input));             // { success: true, data }
});
```

| Piece | File |
|---|---|
| `validate({ params, query, body, headers })`, `req.validated` | `src/middleware/validate.ts` |
| `objectId`, `complaintPublicId`, `text`, `queryInt`, `idParams` | `src/validation/common.ts` |
| `paginationQuery`, `sortQuery`, `toSkipLimit`, `paginationMeta` | `src/validation/pagination.ts` |
| `sendSuccess`, `sendCreated`, `sendNoContent` | `src/utils/respond.ts` |
| `AppError`, error codes, `validationError`, `notFoundError` | `src/utils/errors.ts` |
| `createRateLimiter({ windowMs, limit })` (not applied to any route yet) | `src/middleware/rateLimit.ts` |

Throw `AppError` for expected failures. Anything else is logged with a redacted stack and returned as a generic 500. Mongoose validation and cast errors become 400, duplicate keys become 409 (field names only, never values), and database outages become 503. Response formats and codes: [`docs/api/API_CONVENTIONS.md`](../docs/api/API_CONVENTIONS.md).

## Logging and request IDs

- Structured JSON logs (pino) with `time`, `level`, `service`, `env` and, per request, `requestId`. One line per request: method, path (without query string), status, error code, duration. 4xx errors appear only in that line; unexpected errors also get one line with a redacted stack.
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
| `tests/auth.test.ts` | Register, login, refresh rotation and reuse detection, logout, token tampering and expiry, rate limits, role and department guards, CORS, log and response secrecy |
| `tests/departments.test.ts` | Profile updates, department CRUD and deactivation, membership add, reactivate, role change and revoke, per-department authority, concurrency, audit |
| `tests/complaints.test.ts` | Complaint creation (field allowlist, IDs, rate limit), visibility per role and department, filters, classify and reject lifecycle, races |
| `tests/analysis.test.ts` | AI pipeline with scripted providers: classification validation and side effects, retries, failures, crash recovery, duplicates, analysis API access, Claude adapter mapping, media authenticity |
| `tests/conventions.test.ts` | Validation details, unknown-field rejection, 415, pagination limits, success envelope, error mapping (409/400/500), rate limit, log content |

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
