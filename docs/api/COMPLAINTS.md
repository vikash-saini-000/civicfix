# Complaints API

Status: **Phases 6–7, implemented in `server/`.** Later lifecycle steps: [assignment and work orders](ASSIGNMENTS_WORK_ORDERS.md), [resolution, disputes and closing](EVIDENCE_VERIFICATION_DISPUTES.md). All endpoints need `Authorization: Bearer <accessToken>` ([AUTHENTICATION.md](AUTHENTICATION.md)). Envelope, errors and pagination follow [API_CONVENTIONS.md](API_CONVENTIONS.md). Roles and memberships: [USERS_DEPARTMENTS_MEMBERSHIPS.md](USERS_DEPARTMENTS_MEMBERSHIPS.md).

## Endpoints

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/v1/complaints` | any signed-in user | Report a problem |
| `GET /api/v1/complaints` | any signed-in user (scope rules below) | List complaints |
| `GET /api/v1/complaints/:publicId` | reporter, department staff, admin | One complaint |
| `POST /api/v1/complaints/:publicId/classify` | platform admin | Manual triage: confirm category, route to a department, set priority |
| `POST /api/v1/complaints/:publicId/reject` | platform admin, or a manager of the complaint's department | Reject during triage, with a reason shown to the citizen |
| `GET /api/v1/complaints/:publicId/analysis` | platform admin, staff of the complaint's department | AI suggestion, duplicate candidates, media checks ([AI_ANALYSIS_PIPELINE.md](../ai/AI_ANALYSIS_PIPELINE.md)) |
| `POST /api/v1/complaints/:publicId/analysis` | platform admin | Re-run analysis (202) |

`:publicId` is the human-readable ID, e.g. `CF-2026-00141` (case-insensitive). There is **no** generic `PATCH`: status and routing change only through the action endpoints, and the citizen's original report is kept as submitted.

## Complaint object

```json
{
  "id": "6adc84f1c2a3b4d5e6f70812",
  "publicId": "CF-2026-00001",
  "title": "Deep pothole near the bus stop",
  "description": "Large pothole on the service road, two-wheelers swerve into traffic.",
  "location": { "lat": 13.0072, "lng": 74.7956 },
  "landmark": "Surathkal bus stop",
  "selectedCategory": "roads",
  "confirmedCategory": "roads",
  "department": { "id": "6adc806b7815ccac1fac5a43", "name": "Roads and Public Works" },
  "priority": "P2",
  "status": "UNDER_REVIEW",
  "statusHistory": [
    { "status": "REPORTED", "at": "2026-10-24T10:15:00.000Z", "note": null },
    { "status": "UNDER_REVIEW", "at": "2026-10-24T10:20:00.000Z", "note": "Sent to Roads and Public Works for review." }
  ],
  "rejectionReason": null,
  "reporter": { "id": "6adc84e0c2a3b4d5e6f70801", "name": "Asha" },
  "allowedActions": ["classify", "reject"],
  "createdAt": "2026-10-24T10:15:00.000Z",
  "updatedAt": "2026-10-24T10:20:00.000Z"
}
```

| Field | Notes |
|---|---|
| `selectedCategory` | What the citizen picked (or `null` for "not sure") |
| `confirmedCategory`, `department`, `priority` | `null` until triage. Set by the server only. |
| `statusHistory` | Citizen-facing timeline, oldest first. `note` is safe to show to the citizen. |
| `rejectionReason` | Set when `status` is `REJECTED` |
| `reporter` | **Only for staff and admins**: id and name, never email or other contact details. Absent in the reporter's own view. |
| `allowedActions` | What the caller can do right now: `classify`, `reject`. Use it to show buttons; the server re-checks every action. |
| `location` | Decimal degrees, `lat` −90…90, `lng` −180…180 (stored as GeoJSON `[lng, lat]`) |

**For the existing client mock** (`client/src/lib/domain.ts`): `history[].note` is now `statusHistory[].note`, `department` is `{ id, name }` instead of a string, and `photoCount` isn't available yet (photos come with evidence upload).

## Create: POST /api/v1/complaints

```json
{
  "title": "Deep pothole near the bus stop",
  "description": "Large pothole on the service road, two-wheelers swerve into traffic.",
  "location": { "lat": 13.0072, "lng": 74.7956 },
  "landmark": "Surathkal bus stop",
  "selectedCategory": "roads"
}
```

| Field | Rules |
|---|---|
| `title` | Required, 5–120 characters, trimmed |
| `description` | Required, 10–2000 characters, trimmed. Any language. |
| `location` | Required `{ lat, lng }` numbers, no other keys |
| `landmark` | Optional, 1–120 characters |
| `selectedCategory` | Optional: `roads`, `garbage`, `streetlight`, `water`, `drainage`, `other`, or `null` |

**Server-controlled, rejected with 400 if sent:** `status`, `priority`, `department`/`departmentId`, `confirmedCategory`, `citizen`/`reporter`, `publicId`, `duplicateOf`, or any other key. The reporter is always the signed-in user, and the status always starts as `REPORTED`.

`201 Created`, `Location: /api/v1/complaints/CF-2026-00001`, body `{ "success": true, "data": { "complaint": { … } } }`.

Limit: **20 new complaints per user per hour** (`429 RATE_LIMITED` after that).

## List: GET /api/v1/complaints

| Query | Default | Meaning |
|---|---|---|
| `scope` | `mine` | `mine`: complaints you reported. `department`: complaints routed to departments where you're an active member or manager. `all`: everything (platform admins only). |
| `departmentId` | | With `scope=department`: one of your departments (another department → 403). With `scope=all`: any department. With `scope=mine`: just narrows your own. |
| `unassigned` | | `true`: complaints with no department yet (platform admins only) |
| `status` | | One or more, comma-separated: `status=REPORTED,UNDER_REVIEW` |
| `category` | | Confirmed category, or the citizen's choice while unconfirmed |
| `priority` | | `P1`…`P4` |
| `createdFrom`, `createdTo` | | ISO 8601 with offset, e.g. `2026-10-01T00:00:00Z`; from is inclusive, to is exclusive |
| `sort` | `-createdAt` | `createdAt`, `updatedAt`, `priority` (prefix `-` for descending) |
| `page`, `limit` | `1`, `20` | `limit` max 100 |

`200`: `data` is an array of complaint objects; `meta.pagination` counts **only complaints you may see**. Unknown parameters or values → `400`.

## Read: GET /api/v1/complaints/:publicId

`200 { "data": { "complaint": { … } } }`. If the complaint doesn't exist **or you may not see it**, the response is the same `404 NOT_FOUND`, so IDs reveal nothing.

## Who can see what

| Caller | Sees |
|---|---|
| Reporter | Their own complaints, at any status |
| Department member or manager | Complaints whose `department` is one where they have an **active** membership in an **active** department. Read-only, except managers can reject during triage. |
| Platform admin | Everything, including complaints with no department yet |
| Anyone else | Nothing (404) |

A complaint with **no department** (status `REPORTED`, not yet triaged) is visible only to its reporter and to platform admins. Revoking a membership removes access on the next request.

## Lifecycle

Statuses: `REPORTED`, `UNDER_REVIEW`, `ASSIGNED`, `ACCEPTED`, `IN_PROGRESS`, `BLOCKED`, `RESOLUTION_SUBMITTED`, `VERIFICATION_REQUIRED`, `RESOLVED`, `CLOSED`, `REJECTED`.

**Reachable now:**

```
REPORTED ──AI analysis succeeds (automatic)──▶ UNDER_REVIEW
REPORTED ──classify──▶ UNDER_REVIEW ──classify (re-route)──▶ UNDER_REVIEW
REPORTED / UNDER_REVIEW ──reject──▶ REJECTED   (final)
```

**Defined but not reachable yet:** assignment and work (`ASSIGNED`, `ACCEPTED`, `IN_PROGRESS`, `BLOCKED`, Phase 8), resolution and verification (`RESOLUTION_SUBMITTED`, `VERIFICATION_REQUIRED`, `RESOLVED`, `CLOSED`, reopening, Phase 9). The full table is in `server/src/policies/complaintLifecycle.ts`. Citizens can never set a status.

### POST /api/v1/complaints/:publicId/classify (platform admin)

```json
{ "departmentId": "6adc806b7815ccac1fac5a43", "category": "roads", "priority": "P2", "note": "Optional public note" }
```

- `departmentId` must be an **active** department whose `categories` include `category`; otherwise `400` (`details[0].field = "body.departmentId"`).
- `priority` is optional.
- `note` is optional and is shown to the citizen; the default is "Sent to *Department* for review."
- Allowed from `REPORTED` or `UNDER_REVIEW` (re-routing); otherwise `409 CONFLICT`.
- `200` with the updated complaint.

### POST /api/v1/complaints/:publicId/reject (admin, or manager of the complaint's department)

```json
{ "reason": "This road is maintained by the highway authority." }
```

- `reason` is 5–1000 characters and is **shown to the citizen**, both in `rejectionReason` and in the last history note.
- Allowed from `REPORTED` or `UNDER_REVIEW`; otherwise `409`.
- A complaint without a department can only be rejected by an admin.

If two actions race, one succeeds and the other gets `409`.

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid body, query or public ID; server-controlled field sent; department doesn't handle the category |
| 401 | `UNAUTHENTICATED` | Missing or expired token |
| 403 | `FORBIDDEN` | Visible but not allowed (e.g. a citizen trying to classify); `scope=department` without membership; `scope=all` / `unassigned` without admin |
| 404 | `NOT_FOUND` | No such complaint, **or** not visible to you |
| 409 | `CONFLICT` | Action not allowed in the current status, or lost a race |
| 429 | `RATE_LIMITED` | Too many new complaints |

## Privacy

- Citizens never see other citizens' complaints. Staff see the reporter's **name** only, never their email.
- The exact location is shown to the reporter and to the staff handling it; there is no public or anonymous view yet.
- Audit entries (`complaint.created`, `complaint.classified`, `complaint.rejected`) record actor, target and changed fields, never request bodies.

## Not implemented yet

- AI suggestions are advice only: a human still routes the complaint with `classify`. When AI is disabled or fails, the complaint simply stays `REPORTED` for manual triage.
- Work orders and assignment (Phase 8). Evidence and photo upload, resolution verification, disputes and feedback (Phase 9). Notifications (Phase 10).
- Citizen edits or withdrawal of a complaint; a public map or anonymous reporting.
