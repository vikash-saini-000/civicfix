# CivicFix server

**Status:** all 12 backend phases implemented: auth and roles, departments, complaints, AI analysis, rule-based assignment and work orders, evidence and resolution verification, disputes, notifications, audit API, dashboards, and the Phase 12 security review and deployment readiness. See [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) and [`docs/SECURITY_REVIEW.md`](../docs/SECURITY_REVIEW.md).

For client developers: every API contract is in [`docs/api/`](../docs/api/) (start with [`API_CONVENTIONS.md`](../docs/api/API_CONVENTIONS.md)); the AI pipeline is in [`docs/ai/AI_ANALYSIS_PIPELINE.md`](../docs/ai/AI_ANALYSIS_PIPELINE.md).

Stack: Node 22+ (ESM), TypeScript, Express 5, Mongoose 9, zod 4, pino, Vitest.

## Run locally

Requires a MongoDB connection (Atlas or a local 8.0 service). For video evidence, **ffmpeg and ffprobe** must be installed (on the PATH, or set `FFMPEG_PATH` / `FFPROBE_PATH`); without them videos only get metadata checks and a warning is logged at startup.

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
| `npm run user:create:prod` / `npm run db:sync-indexes:prod` | Same scripts from the compiled build (no dev dependencies needed) |
| `npm run user:create` | Create an account outside public registration, e.g. the first `PLATFORM_ADMIN` (password from `NEW_USER_PASSWORD`) |
| `npm run db:sync-indexes` | Create/update model indexes (needed in production, where auto-indexing is off). It also drops indexes no longer in the schemas. |
| `npm run db:seed` | Local demo data (refused in production): `admin@civicfix.local`, `citizen@civicfix.local`, and one department per category with `<dept>.manager@`, `<dept>.worker1@`, `<dept>.worker2@civicfix.local`. All use `SEED_PASSWORD`. Safe to re-run. |
| `npm run e2e:live` | Full journey (complaint → AI → assignment → work → verification → dispute → rework → close → feedback, plus notifications, dashboards, audit) over HTTP against the **running** server. Needs `db:seed`; reads `SEED_PASSWORD` from the env or `.seed-credentials`. Makes real AI calls when AI is on. Uploads carry an in-app camera stamp like the app does; it checks that a gallery file and the drawn fixture photo are refused, then needs two real camera JPEGs (`E2E_BEFORE_PHOTO`, `E2E_AFTER_PHOTO`) for the rest. |
| `npm run ai:live` | Live check of the AI provider and agent (real calls). |

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
| `ANTHROPIC_API_KEY` / `AICREDITS_API_KEY` | none | Exactly one when `AI_PROVIDER=anthropic`: direct Anthropic API, or the AiCredits.in prepaid gateway (then `AI_MODEL` must be a gateway ID such as `anthropic/claude-opus-5.5`). Never logged. Out-of-credit or over-budget responses are reported as `CREDITS_EXHAUSTED`. |
| `AI_MODEL` / `AI_TIMEOUT_MS` / `AI_MAX_ATTEMPTS` | `claude-opus-5-5` / `30000` / `3` | Model ID, per-call timeout, attempts per job |
| `AI_TRIAGE_MODE` / `AI_AGENT_MAX_TURNS` | `single` / `6` | `agent` = tool-using triage agent (several calls per complaint); max model calls per agent run (2–10) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` via AiCredits | Semantic duplicate search; `disabled` = word overlap only |
| `MEDIA_UPLOAD_GATE` | `block` | Authenticity check at upload, before storing. `strict` = also refuse files with only *some* signs of editing/generation or an editing-app tag; `block` = refuse files flagged as AI-generated or edited (`422 MEDIA_REJECTED`); `flag` = store everything and mark for review |
| `EVIDENCE_CAPTURE` | `camera` | `camera` = every photo/video must carry a valid in-app camera stamp (`422 CAPTURE_REQUIRED` otherwise); `any` = gallery files allowed too |
| `CAPTURE_SESSION_TTL_SECONDS` | `1800` | How long a camera session token is valid (60–7200) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Video tools (frames, details, privacy copies, WebM → MP4) |
| `MAX_VIDEO_SECONDS` | `60` | Longest accepted video (5–300) |
| `GEOCODER` / `GEOCODER_URL` / `GEOCODER_USER_AGENT` | `nominatim` (`disabled` in tests) / public OpenStreetMap server / `CivicFix/0.1 (…)` | Street addresses for map points (`GET /api/v1/geo/reverse`, and saved on each new complaint as `address`). Server-side, cached per ~11 m, at most 1 request/s per the Nominatim usage policy. `disabled` = ward and nearest mapped place only. |
| `STORAGE_PROVIDER` / `STORAGE_LOCAL_DIR` | `disabled` / `./uploads` | Evidence file storage: `disabled` (uploads return 503) or `local` |
| `AUTO_APPROVE_RESOLUTIONS` | `false` | Approve fully clean resolutions without a human (product-owner decision) |
| `DISPUTE_WINDOW_DAYS` | `14` | Days after resolution in which citizens may dispute (1–90) |
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
| Media authenticity signals (photos and videos) | `src/services/analysis/mediaAuthenticity.ts` |
| Upload gate (`screenMedia`, `gateAllows`), cached by file hash | `src/services/analysis/index.ts` |
| ffmpeg/ffprobe: video details, frames, privacy copy, WebM → MP4 | `src/media/video.ts` |
| In-app camera sessions (signed tokens, stamp checks) | `src/services/captureSessions.ts` |
| Summary, re-run and `analyzeEvidence` | `src/services/analysis/index.ts` |

`server.ts` starts the runner after the server starts listening and stops it on shutdown. `createApp` without an `analysis` dependency only queues jobs and runs nothing, which keeps tests deterministic. **After pulling Phase 7, run `npm run db:sync-indexes`** on existing databases: an `AIAnalysis` unique index changed.

## Evidence: real media only

Every photo and video goes through these steps **before it is stored**:

1. **Camera stamp** (`EVIDENCE_CAPTURE=camera`): the app opens a camera session (`POST /api/v1/evidence/capture-sessions`), and each capture is uploaded with `X-Capture-Token`, `X-Captured-At` and, when the device has a fix, `X-Capture-Lat` / `X-Capture-Lng` / `X-Capture-Accuracy`. The token is HMAC-signed with a key derived from `JWT_SECRET`, bound to the user, and the capture time must fall inside the session. Files without a valid stamp are refused. The stamp's time and GPS are stored as the evidence's capture time and location and feed the 50 m / timing checks in verification.
2. **Type and size** from the bytes: JPEG, PNG, WebP (10 MB); MP4, MOV (50 MB, up to `MAX_VIDEO_SECONDS`). Browser recordings (WebM) are converted to MP4 with ffmpeg first.
3. **Authenticity check**: metadata (AI-generator and editing-app names, IPTC "trained algorithmic media", content-credential manifests) plus a vision model. Videos send 4 frames from across the clip in one call. `MEDIA_UPLOAD_GATE` decides what is refused. The result is stored as the file's authenticity record, so it isn't paid for twice.

After storing, a background job makes the shareable copy (faces and number plates pixelated, metadata removed; videos re-encoded as MP4) and, for resolution files, the before/after comparison.

Limits: the stamp raises the bar but a determined person can still script the API; the AI check reports signals, not proof. If the AI is unavailable, files are let through as `INCONCLUSIVE` and marked for review.

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

Tests share **one** throwaway in-memory MongoDB started by `tests/globalSetup.ts` (`mongodb-memory-server-core`); each test file uses its own database name. They never touch the local service or a shared database. To use the installed binary instead of downloading one:

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
| `tests/workOrders.test.ts` | Automatic routing rules, manual assignment, review queue, work-order lifecycle, transfer and cancel, races |
| `tests/resolution.test.ts` | Evidence upload, type and size checks, access, storage off; upload gate (AI/edited files refused, pre-check, strict); in-app camera stamps and WebM conversion; video evidence end to end; resolution checks, verifier decisions, disputes, close, feedback |
| `tests/video.test.ts` | ffprobe parsing, frame sampling, privacy-copy filter, video authenticity checks (needs ffmpeg; skipped otherwise) |
| `tests/capture.test.ts` | Camera session tokens (signature, user, time window, GPS) and the strict/block/flag gate |
| `tests/agent.test.ts` | Triage agent tool loop, limits and failure handling |
| `tests/notifications.test.ts` | Notification recipients, privacy, no duplicates, failure isolation; audit API access, filters, sanitising |
| `tests/dashboards.test.ts` | Citizen, member, manager and admin metrics, scoping, empty states, range validation |
| `tests/e2e.test.ts` | Full workflow through the HTTP API: setup → complaint → AI → assignment → work → verification → dispute → rework → close |
| `tests/security.test.ts` | Every protected route needs a token; production headers, CORS, error safety, body limits |
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
