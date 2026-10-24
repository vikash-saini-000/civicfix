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
| `src/lib/domain.ts` | Complaint types, the 11 blueprint statuses, citizen-facing labels, priorities, categories |
| `src/api/` | `CivicFixApi` interface, HTTP client, deterministic mock implementation, configuration, and errors |
| `src/components/` | Shared UI: Button, fields, StatusTag, PriorityBadge, Notification, LocationPicker, PhotoInput, StatusTracker, Layout |
| `src/pages/` | Home, Report a problem, My complaints, Complaint detail |

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

## Connecting the backend

The HTTP implementation of `CivicFixApi` is already present in `src/api/httpApi.ts` and targets the proposed
`/api/v1/complaints` and authentication contracts. Set both `VITE_CIVICFIX_API_MODE=http` and
`VITE_CIVICFIX_AUTH_MODE=http` when the backend is ready. The optional authentication-token hook remains available
for a future contract that explicitly requires bearer authentication.

The mock stores new complaints in `localStorage` and moves each one to "Under review" after 4 seconds to simulate the backend.

## Design

Based on the IBM / Carbon reference from the `design-system` project skill (`awesome-design-md/design-md/ibm`), adapted for CivicFix:

- White canvas, charcoal text, one blue accent (`#0f62fe`), square corners, 1px hairlines, 4px spacing grid, IBM Plex Sans (Google Fonts).
- Changes from the reference: regular-weight headings instead of light display type, dark text on yellow for contrast, and civic status and priority colours.
- Status always appears as a text label plus colour.
- Carbon-style 2px blue focus outline.
- 48px touch targets.
- Breakpoints at 672px and 1056px.

Not covered yet: real backend authentication, dark mode, department and manager workflows, disputes and feedback, and translated UI text (complaints can already be written in any language).
