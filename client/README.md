# CivicFix client

Citizen web app: report a problem, list my complaints, track a complaint's status.

**Status:** frontend shell on **mock data**. It is not connected to a backend yet. A "Demo mode" banner says so on every page.

## Run

```bash
cd client
npm install
npm run dev        # http://localhost:5173
npm run test       # focused unit and route tests
npm run build      # type-check + production build
```

## Structure

| Path | What it holds |
|---|---|
| `src/app/` | Application shell and centralized route configuration |
| `src/index.css` | Design tokens (Tailwind v4 `@theme`) and base styles |
| `src/lib/domain.ts` | Complaint types, the 11 blueprint statuses, citizen-facing labels, priorities, categories, and safe unknown-status fallback |
| `src/lib/complaints.ts` | Authorized complaint list presentation helpers, client-side filtering/sorting, location summaries, and safe load errors |
| `src/api/` | `CivicFixApi` interface, HTTP client, deterministic mock implementation, configuration, and errors |
| `src/components/` | Shared UI: Button, fields, StatusTag, PriorityBadge, Notification, LocationPicker, PhotoInput, StatusTracker, Layout |
| `src/pages/` | Home, Citizen dashboard, Report a problem, My complaints, Complaint detail |

## API mode

Copy `.env.example` to `.env.local` when you want to make the mode explicit:

```bash
VITE_CIVICFIX_API_MODE=mock
VITE_CIVICFIX_API_BASE_URL=
VITE_CIVICFIX_API_TIMEOUT_MS=10000
VITE_CIVICFIX_AUTH_MODE=mock
```

The development default is `mock`. A production build defaults to `http` and uses the same origin unless
`VITE_CIVICFIX_API_BASE_URL` is set. A failed HTTP request never falls back to mock data.

## Authentication

The project documents, but does not yet implement, these proposed backend endpoints in
`docs/CivicFixFullDetails.pdf` (API modules section):

```text
POST /api/v1/auth/login
GET  /api/v1/auth/me
POST /api/v1/auth/logout
POST /api/v1/auth/register
```

Phase 2 uses a typed adapter around those proposed contracts. The HTTP adapter sends credentialed requests for a
cookie/session-based backend and does not persist passwords, session identifiers, access tokens, or refresh tokens in
browser storage. The backend must provide the actual session, CSRF, response, and role contracts before HTTP auth can
be considered integrated.

Development mock authentication is memory-only and available only when both API and auth modes are `mock` in a
development build. It exposes four clearly labeled demo accounts on the login screen. Mock authentication is rejected
in production configuration and never activates after an HTTP failure.

The frontend route guards are a UX layer only. The backend must independently enforce authentication, role, department
scope, ownership, and permissions.

## Citizen complaint submission

The canonical citizen submission route is:

```text
/citizen/complaints/new
```

`/report` remains as a backwards-compatible alias. Both routes require a validated citizen session through the Phase 2
route guard.

The only available complaint-creation contract is provisional. The project blueprint proposes `POST /api/v1/complaints`
(`docs/CivicFixFullDetails.pdf`, API modules section), while the current frontend draft is defined by
`src/lib/domain.ts` and `src/api/types.ts`:

```text
title: string
description: string
location: { lat: number; lng: number }
landmark?: string
selectedCategory: CategoryId | null
photos: File[]
```

The client validates the current draft limits (title 5–120 characters, description 10–2000 characters, valid geographic
coordinates, up to 3 images of 10 MB each). These limits remain provisional until backend validators are available.

The mock adapter accepts image attachments for local UI testing but stores only photo counts; it does not persist image
contents to a real service. The HTTP adapter currently reports photo uploads as unavailable because no backend upload,
storage, or signed-URL contract exists. Text and location submission remains isolated behind the typed API boundary.

## Connecting the backend

The HTTP implementation of `CivicFixApi` is already present in `src/api/httpApi.ts` and targets the proposed
`/api/v1/complaints` and authentication contracts. Set both `VITE_CIVICFIX_API_MODE=http` and
`VITE_CIVICFIX_AUTH_MODE=http` when the backend is ready. The optional authentication-token hook remains available
for a future contract that explicitly requires bearer authentication.

The mock stores new complaints in `localStorage` and moves each one to "Under review" after 4 seconds to simulate the backend.

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
contract state and never fabricates notifications or unread counts. Existing complaint `history` events remain the supported
activity-history source and are shown on authorized complaint detail pages; there is no separate activity-feed or audit-log
endpoint exposed to the frontend.

## Phase 9 search, filtering, and sorting

Citizen and department complaint lists use the complete authorized arrays returned by their existing adapters. Search, status,
category, priority, and sorting are local-only operations because the current API exposes no pagination or query-parameter
contract. Search inputs include accessible labels and clear controls. No unsupported server parameters or result totals are sent
or claimed.

## Design

Based on the IBM / Carbon reference from the `design-system` project skill (`awesome-design-md/design-md/ibm`), adapted for CivicFix:

- White canvas, charcoal text, one blue accent (`#0f62fe`), square corners, 1px hairlines, 4px spacing grid, IBM Plex Sans (Google Fonts).
- Changes from the reference: regular-weight headings instead of light display type, dark text on yellow for contrast, and civic status and priority colours.
- Status always appears as a text label plus colour.
- Carbon-style 2px blue focus outline.
- 48px touch targets.
- Breakpoints at 672px and 1056px.

Not covered yet: real backend authentication, backend staff complaint contracts, dark mode, manager workflows, disputes and feedback, and translated UI text (complaints can already be written in any language).
