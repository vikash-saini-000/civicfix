# CivicFix client

Citizen web app: report a problem, list my complaints, track a complaint's status.

**Status:** frontend shell on **mock data**. It is not connected to a backend yet. A "Demo mode" banner says so on every page.

## Run

```bash
cd client
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
```

## Structure

| Path | What it holds |
|---|---|
| `src/index.css` | Design tokens (Tailwind v4 `@theme`) and base styles |
| `src/lib/domain.ts` | Complaint types, the 11 blueprint statuses, citizen-facing labels, priorities, categories |
| `src/api/` | `CivicFixApi` interface, mock implementation, and the single switch in `index.ts` |
| `src/components/` | Shared UI: Button, fields, StatusTag, PriorityBadge, Notification, LocationPicker, PhotoInput, StatusTracker, Layout |
| `src/pages/` | Home, Report a problem, My complaints, Complaint detail |

## Connecting the backend

Write an HTTP implementation of `CivicFixApi` (`src/api/types.ts`) against `/api/v1/complaints` and export it from `src/api/index.ts` instead of `mockApi`. Set `USING_MOCK_API = false` to hide the demo banner. Pages don't need to change.

The mock stores new complaints in `localStorage` and moves each one to "Under review" after 4 seconds to simulate the backend.

## Design

Based on the IBM / Carbon reference from the `design-system` project skill (`awesome-design-md/design-md/ibm`), adapted for CivicFix:

- White canvas, charcoal text, one blue accent (`#0f62fe`), square corners, 1px hairlines, 4px spacing grid, IBM Plex Sans (Google Fonts).
- Changes from the reference: regular-weight headings instead of light display type, dark text on yellow for contrast, and civic status and priority colours.
- Status always appears as a text label plus colour.
- Carbon-style 2px blue focus outline.
- 48px touch targets.
- Breakpoints at 672px and 1056px.

Not covered yet: dark mode, department and manager views, disputes and feedback, and translated UI text (complaints can already be written in any language).
