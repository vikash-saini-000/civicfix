# CivicFix client

React app for citizens, department staff, managers and platform administrators.

**Status:** connected to the CivicFix backend (`server/`). HTTP mode is the default. Mock mode (in-memory demo
data) is still available for UI work without a server; it shows a "Development mode" banner.

## Run with the backend

```bash
# terminal 1: API on http://localhost:4000 (needs MongoDB and server/.env)
cd server && npm run dev

# terminal 2: app on http://localhost:5173
cd client && npm install && npm run dev
```

In development Vite proxies `/api` to `http://localhost:4000` (`vite.config.ts`), so the app and API share one
origin and the refresh cookie works without cross-site cookie settings. Demo accounts come from
`cd server && npm run db:seed` (`admin@civicfix.local`, `citizen@civicfix.local`, department managers and workers);
their password is in `server/.seed-credentials`. Citizens can also create an account at `/register`.

```bash
npm run test       # unit and route tests (page tests use the mock adapter)
npm run build      # type-check + production build
```

## API mode

`.env.example` lists the settings. Copy it to `.env.local` to change them.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_CIVICFIX_API_MODE` | `http` | `http` = real backend; `mock` = local demo data (development builds only for auth) |
| `VITE_CIVICFIX_API_BASE_URL` | empty (same origin) | Set only when the API is hosted on another origin (it must then list this app in `CORS_ORIGINS`, and cross-site cookies need `COOKIE_SAMESITE=none` + HTTPS) |
| `VITE_CIVICFIX_API_TIMEOUT_MS` | `10000` | Per-request timeout (uploads and media checks use 3 minutes) |
| `VITE_CIVICFIX_AUTH_MODE` | same as API mode | Must match the API mode |

A failed HTTP request never falls back to mock data.

## How the client talks to the backend

All calls go through `src/api/httpApi.ts`, which follows `docs/api/*.md`:

- **Auth** (`docs/api/AUTHENTICATION.md`): the 15-minute access token is kept in memory only and sent as
  `Authorization: Bearer`. On start-up the app calls `POST /auth/refresh` (HttpOnly cookie +
  `X-Requested-With: civicfix`) to restore the session. Only one refresh runs at a time (Web Locks across tabs),
  the token is refreshed shortly before it expires, and a request that gets `401 UNAUTHENTICATED` is retried once
  after a refresh.
- **User roles:** the backend user (`platformRole`, `roles`, `memberships`) is mapped in `src/api/backendUser.ts`
  to one workspace: platform admin > department manager > department member > citizen. Department names come
  from `GET /departments`.
- **Errors:** the `{ error: { code, message, details } }` envelope becomes `ApiError(status, code)`.
- **Lists** follow `meta.pagination` (100 per page).
- **Photos** are uploaded after the complaint is created, as raw bytes to `POST /complaints/:id/evidence`. A failed
  photo upload never loses the report; the detail page says how many failed. Evidence previews are fetched with the
  bearer token into blob URLs.

| Role | Screens | Backend endpoints |
|---|---|---|
| Citizen | Sign-up (`/register`: live validation matching the server rules, password strength, privacy notice, duplicate-email path to log in, welcome panel on first visit), dashboard, report, my complaints, detail (follow-up answers, extra photos, confirm and close, dispute, rating), notifications | `/complaints`, `/complaints/:id/{follow-up,evidence,close,disputes,feedback}`, `/notifications` |
| Department member | Workspace, **My work** (`/department/work`), work order detail (accept, decline, start, hold, notes, progress and resolution photos, submit fix), department complaints with AI analysis | `/work-orders`, `/work-orders/:id/*`, `/complaints?scope=department`, `/complaints/:id/analysis` |
| Department manager | Overview (`/manager`), complaint review queue with AI suggestion and routing form, resolution review, assignment exceptions, verification (approve / reject / ask for evidence), staff assignment | `/assignments/queue`, `/complaints/:id/{assign,reject}`, `/work-orders/:id/{assign,cancel,verification}`, `/dashboard/department/manager`, `/departments/:id/members` |
| Platform admin | Overview (live metrics + complaint analytics), triage queue (create work order or route only), all work orders (transfer), departments and members | `/dashboard/admin`, `/complaints?scope=all`, `/complaints/:id/classify`, `/work-orders/:id/transfer`, `/departments` |

Buttons follow each record's `allowedActions`; the server re-checks every action. The route guards are a UX layer
only.

Not wired yet (backend endpoints exist): dispute review for managers (`/disputes`), the audit log viewer
(`/audit-logs`), duplicate linking (`/complaints/:id/duplicate-of`), department create/edit and membership changes,
the citizen dashboard endpoint, and analytics maps (`/analytics/*`).

## Citizen complaint submission

Routes: `/citizen/complaints/new` (and the alias `/report`), behind the citizen route guard.

The form collects title, description, map location, optional landmark and category, and up to **3 photos or videos**. On submit, each file is first checked by the server (`POST /api/v1/evidence/check`); if one looks AI-generated or edited the complaint is **not** created and the form returns to the photo step naming the file. Then the complaint is created and the files are uploaded.

## Location in words

After the citizen taps the map, types coordinates or uses **Use my current location**, `LocationPicker` asks the server for `GET /api/v1/geo/reverse` and shows the street address (OpenStreetMap), the nearest mapped landmark with its distance, and the ward. For "current location" it also shows the GPS accuracy, and warns when the fix is rough (over ±100 m, common on laptops) so the citizen can correct the pin. The review step and all complaint pages show the saved address next to the coordinates.

## Photos and videos: in-app camera

The server's capture rules come from `GET /api/v1/evidence/capture-policy` (`src/lib/capture.ts`, `useCapturePolicy`).

| Server setting | What the app shows |
|---|---|
| `EVIDENCE_CAPTURE=camera` (default) | Only **Take a photo or video**. The gallery/file picker isn't offered. |
| `EVIDENCE_CAPTURE=any` | **Take a photo or video** and **Choose files** |

`src/components/CameraCapture.tsx`:

- Opens a camera session (`POST /api/v1/evidence/capture-sessions`) and the back camera (`getUserMedia`, `facingMode: environment`), and watches GPS while open.
- **Take photo** grabs a frame into a JPEG; **Record video** uses `MediaRecorder` (MP4 where supported, otherwise WebM, which the server converts), stopping automatically at the server's video limit.
- Each capture is stamped with the session token, the capture time and the GPS fix (`src/lib/captureStamp.ts`); the API client sends these as `X-Capture-*` headers on the check and the upload.
- If the page can't use the camera (plain HTTP on a phone, old browser), it opens the phone's own camera app (`<input capture="environment">`) and only accepts a file created in the last 3 minutes.
- **HTTPS is required** for the camera and GPS on phones (`localhost` is fine on a computer).

The same camera is used in the evidence panels: extra citizen photos, worker progress and **resolution** photos/videos, and dispute evidence. Staff see "Taken with the in-app camera" on each such file, and the AI authenticity badge.

Uploads and checks use a longer request timeout (3 minutes) because the server runs the AI check (and ffmpeg for videos) before answering.

## Citizen dashboard and tracking

The Phase 4 canonical routes are:

```text
/citizen/dashboard
/citizen/complaints
/citizen/complaints/:complaintId
```

`/citizen` remains a compatibility alias for the dashboard. The earlier `/complaints` and `/complaints/:publicId` routes
remain guarded compatibility aliases; new navigation uses the canonical citizen paths. All citizen routes reuse the Phase 2
authentication and citizen-role guards.

The current typed API boundary exposes:

```text
GET /api/v1/complaints
GET /api/v1/complaints/:id
```

These routes are proposed in `docs/CivicFixFullDetails.pdf`, API modules section, and are not implemented in this repository.
The current adapter contract returns an authorized `Complaint[]` list and a `Complaint | null` detail. It has no pagination
metadata, server-side filter/sort parameters, separate summary-count endpoint, or separate public-history endpoint.

Dashboard counts are exact counts derived from the complete list returned by the adapter for the signed-in citizen. The list
page applies search, exact-status filtering, exact-category filtering, and sorting locally to that returned authorized data;
it does not claim server-side pagination. The UI does not expose department, priority, internal assignment, or other
operational fields in citizen-facing tracking views.

Status history is rendered only from the complaint's typed `history` field, whose draft contract marks notes as citizen-facing.
An empty history produces an explanation rather than an invented timeline. Unknown future status codes receive a readable
fallback instead of crashing the page. The HTTP and mock adapters normalize the citizen-safe fields and do not pass through
department or priority fields. The backend must provide an explicit public-history contract before mixed internal and public
updates can be safely displayed.

## Department workspace

The Phase 5 read-only staff routes are:

```text
/department
/department/complaints
/department/complaints/:complaintId
```

Department routes require a department-member or department-manager role plus at least one authenticated department
membership. Multiple memberships can be selected using a membership-backed `department` query value; arbitrary department
IDs are rejected. The current repository has no backend department complaint endpoint, so the HTTP adapter fails safely with
`DEPARTMENT_API_NOT_CONFIGURED` instead of inventing a production route. The development mock adapter exposes the existing
seed records through a department-scoped, read-only adapter.

## Platform analytics and accessibility

The protected `/admin` route now loads the complete local mock dataset through a mock-only platform analytics capability.
It provides clearly labelled summary metrics, date-range filtering, category and department tables, report-volume trends,
and client-derived resolution timing for interface validation. The HTTP adapter intentionally returns
`PLATFORM_ANALYTICS_NOT_CONFIGURED` because this repository has no authorized platform-wide analytics endpoint, complete
dataset contract, or historical aggregation API. The frontend does not claim that mock values are production statistics.

The shared shell and high-risk workflows include keyboard route focus management, mobile menu Escape/focus restoration,
native required-field semantics, associated validation errors, a keyboard-friendly coordinate alternative to the map,
responsive status/detail layouts, and accessible table alternatives for analytics. Automated coverage remains limited to
the installed Vitest and Testing Library setup; no axe package or browser viewport test runner is installed.

## Phase 6 and Phase 7 workflow contracts

The blueprint lists proposed AI-analysis, manager-review, work-order evidence, verification, and dispute endpoints, but this
repository contains no implemented backend for those contracts. The frontend therefore protects `/manager/review` and its
detail route for department managers, then shows a clear unavailable-contract state without fabricating AI results,
confidence values, review decisions, queue records, evidence uploads, resolution outcomes, verification history, or dispute
eligibility. Citizen and department complaint detail pages similarly avoid showing private resolution data or mutation controls
when the server contract does not provide them.

## Phase 8 notifications and activity history

The authenticated `/notifications` route is present in the shell, but the current repository has no notification endpoint,
unread-count contract, pagination metadata, or read/mark-all mutation. The page therefore shows an explicit unavailable
contract state and never fabricates notifications or unread counts. For citizens, the route now provides a clearly labelled
recent-activity view derived from the authorized complaint `history` already returned by the complaint API; it is not a
persistent notification feed and has no read/unread state. Staff and administrator views remain unavailable until their own
authorized notification contract exists. There is no separate activity-feed or audit-log endpoint exposed to the frontend.

## Phase 9 search, filtering, and sorting

Citizen and department complaint lists use the complete authorized arrays returned by their existing adapters. Search, status,
category, priority, and sorting are local-only operations because the current API exposes no pagination or query-parameter
contract. Search inputs include accessible labels and clear controls. No unsupported server parameters or result totals are sent
or claimed.

## Phase 16 synchronization fallback

The repository has no WebSocket, SSE, notification-list, unread-count, read-state, or activity-feed contract. The frontend
does not invent those endpoints or fabricate notification data. Supported complaint pages and the citizen recent-activity
view now refresh their authorized data when the browser window regains focus or the tab becomes visible. Complaint details
also perform a conservative 30-second refresh while visible; the timer is stopped on unmount and refresh requests are not
allowed to overlap. This is a refresh-on-focus/polling fallback, not instantaneous push delivery.

## Deployment handoff

The app is a Vite React TypeScript client. From `client/`, the production check/build command is `npm run build`; Vite emits
the static bundle to `client/dist`. Set `VITE_CIVICFIX_API_MODE=http` and `VITE_CIVICFIX_AUTH_MODE=http` for a real backend,
and set `VITE_CIVICFIX_API_BASE_URL` only when the API is not same-origin. These `VITE_` values are public browser configuration,
not secrets. The current HTTP adapter still requires the backend's actual session, CSRF, role, complaint, media, analytics, and
notification contracts before those workflows can be considered production-integrated.

## Design

Based on the IBM / Carbon reference from the `design-system` project skill (`awesome-design-md/design-md/ibm`), adapted for CivicFix:

- White canvas, charcoal text, one blue accent (`#0f62fe`), square corners, 1px hairlines, 4px spacing grid, IBM Plex Sans (Google Fonts).
- Changes from the reference: regular-weight headings instead of light display type, dark text on yellow for contrast, and civic status and priority colours.
- Status always appears as a text label plus colour.
- Carbon-style 2px blue focus outline.
- 48px touch targets.
- Breakpoints at 672px and 1056px.

Not covered yet: real backend authentication, backend staff complaint contracts, dark mode, manager workflows, disputes and feedback, and translated UI text (complaints can already be written in any language).
