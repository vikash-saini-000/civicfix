# Assignments and work orders

Status: **Phase 8, implemented in `server/`.** Conventions: [API_CONVENTIONS.md](API_CONVENTIONS.md). Auth: [AUTHENTICATION.md](AUTHENTICATION.md). Resolution and verification: [EVIDENCE_VERIFICATION_DISPUTES.md](EVIDENCE_VERIFICATION_DISPUTES.md).

- **Complaint** = the citizen's report (never edited).
- **Assignment** = the decision routing it to a department. Recorded in the work order's `assignmentSource`, `assignmentReason` and `history`, plus an `assignment.decided` audit entry.
- **Work order** = the department's operational record. Citizens never see work orders; they see the complaint status, which mirrors the work order.

## 1. Automatic assignment (rule-based, policy `assign-v1`)

After both AI jobs finish (classification and duplicate check), the backend evaluates these rules. **All** must pass; otherwise the case goes to human review with the listed reasons. AI output is only one input; the rules decide.

| Rule | Review reason if it fails |
|---|---|
| Automatic routing is switched on (`autoAssignEnabled`) | `POLICY_REQUIRES_APPROVAL` |
| AI classification succeeded | `AI_UNAVAILABLE` |
| Model certainty is `HIGH` | `LOW_CONFIDENCE` |
| Model raised no review flags and didn't recommend review | the model's reasons (e.g. `MULTI_DEPARTMENT`) or `POLICY_REQUIRES_APPROVAL` |
| Suggested priority is not `P1` (urgent cases always get a human) | `HIGH_URGENCY` |
| The citizen's chosen category (if any) equals the AI category | `CATEGORY_CONFLICT` |
| **Exactly one** active department lists that category, and it is the suggested department | `UNCLEAR_DEPARTMENT` / `MULTI_DEPARTMENT` |
| Duplicate check succeeded and found no candidates | `AMBIGUOUS_DUPLICATE` |
| No human has routed it already | (skipped: the department manager decides) |

When all rules pass, the system creates the work order (`assignmentSource: AUTO`, history actor `SYSTEM`), sets the complaint's department, confirmed category and priority, and moves the complaint to `ASSIGNED`.

**Staff pick (deterministic):** an active `MEMBER` (not manager) of the department with an active account and fewer than **10** open work orders. Fewest open work orders wins; ties go to the longest-standing membership. If nobody qualifies, the work order stays `PENDING_ASSIGNMENT` with `reviewRequired: ["NO_ELIGIBLE_MEMBER"]` for the manager.

**Due date:** `dueAt` = assignment time + P1 24 h, P2 72 h, P3 7 days, P4 14 days. An open work order past `dueAt` is `overdue`.

All values live in `DEFAULT_ASSIGNMENT_POLICY` (`server/src/services/workOrders.ts`). **The target times and the auto-assignment switch need product-owner approval.**

## 2. Human decisions

| Who | Can |
|---|---|
| Platform admin | Route any complaint in `REPORTED`/`UNDER_REVIEW` to any active department that handles its category; transfer work between departments |
| Manager of department D | Assign complaints already routed to D (by admin `classify`) to D only; assign or reassign D's staff; cancel D's work orders |
| Member | Act only on work orders assigned to them |
| Citizen | Nothing here |

**Cross-department policy (restrictive default):** a manager can never route to, or act in, another department. Only admins move work between departments (`transfer`). A manager who thinks a case is misrouted cancels the work order with a reason, which sends the complaint back to admin triage.

The decision actor and source always come from the signed-in user. Fields like `source`, `assignedBy` or `actor` in a request body are rejected (`400 unrecognized_key`).

### GET /api/v1/assignments/queue

Complaints in `REPORTED` or `UNDER_REVIEW` waiting for a routing decision. Admins see all; managers see those routed to their departments. Anyone else gets 403. Paginated (`page`, `limit`), oldest first.

```json
{ "success": true, "data": [{ "publicId": "CF-2026-00012", "title": "Pothole near the bus stop", "status": "UNDER_REVIEW", "category": "roads", "priority": null, "department": null, "reviewReasons": ["LOW_CONFIDENCE"], "evaluatedAt": "…", "createdAt": "…" }], "meta": { "pagination": { … } } }
```

AI suggestions for an item: `GET /api/v1/complaints/:publicId/analysis`.

### POST /api/v1/complaints/:publicId/assign

```json
{ "departmentId": "6adc…", "priority": "P2", "category": "roads", "assigneeId": "6adc…", "reason": "Checked photos; road surface damage." }
```

| Field | Rules |
|---|---|
| `departmentId` | Active department that handles the category. Managers: must be their department and the complaint's current department. |
| `priority` | `P1`–`P4`, required |
| `category` | Optional; defaults to the confirmed category, then the citizen's choice |
| `assigneeId` | Optional; must be an active member of that department |
| `reason` | Required, 3–1000 characters, stored in history and audit |

`201` with `Location: /api/v1/work-orders/WO-2026-00001` and `{ "workOrder": … }`. Errors: `403` (not allowed), `404` (complaint not visible), `400` (invalid department, category or assignee), `409` (complaint no longer awaiting assignment, or already has an open work order).

## 3. Work orders

Work-order object (staff and admins only):

```json
{
  "id": "6adc…", "publicId": "WO-2026-00001",
  "complaint": { "publicId": "CF-2026-00012", "title": "…", "status": "ASSIGNED", "landmark": "Bus stop", "location": { "lat": 13.0, "lng": 74.79 } },
  "department": { "id": "…", "name": "Roads" },
  "priority": "P2", "status": "ASSIGNED",
  "assignee": { "id": "…", "name": "Ravi" },
  "assignmentSource": "AUTO", "assignmentReason": "Automatic routing (assign-v1): …", "assignedAt": "…",
  "dueAt": "…", "overdue": false, "reviewRequired": [],
  "acceptedAt": null, "startedAt": null, "blocked": null,
  "notes": [{ "author": { "id": "…", "name": "Ravi" }, "text": "Site visit Monday.", "at": "…" }],
  "history": [{ "at": "…", "action": "created", "actorType": "SYSTEM", "fromStatus": null, "toStatus": "PENDING_ASSIGNMENT", "reason": "…" }],
  "completionNotes": null, "resolutionSubmittedAt": null, "resolutionEvidence": [], "verificationDecision": null,
  "cancelled": null, "completedAt": null,
  "allowedActions": ["accept", "decline"],
  "createdAt": "…", "updatedAt": "…"
}
```

`allowedActions` lists what *you* can do now; use it for buttons. The server re-checks every action. No reporter identity or contact details are included.

### Lifecycle

| Action (`POST /api/v1/work-orders/:id/<action>`) | From | To | Who | Body |
|---|---|---|---|---|
| `assign` | PENDING_ASSIGNMENT, ASSIGNED | ASSIGNED | manager, admin | `{ assigneeId, reason? }` |
| `decline` | ASSIGNED | PENDING_ASSIGNMENT | assignee | `{ reason }` |
| `accept` | ASSIGNED | ACCEPTED | assignee | `{}` |
| `start` | ACCEPTED, BLOCKED (resume) | IN_PROGRESS | assignee | `{}` |
| `block` | ACCEPTED, IN_PROGRESS | BLOCKED | assignee | `{ reason, nextAction }` |
| `notes` | any open | (unchanged) | assignee, manager, admin | `{ text }` |
| `transfer` | any open before resolution | PENDING_ASSIGNMENT (new department) | admin | `{ departmentId, reason }` |
| `cancel` | any open before resolution | CANCELLED | manager, admin | `{ reason }` |
| `resolution`, `verification` | see the evidence and verification doc | | | |

`:id` is `WO-2026-00001` (case-insensitive) or the database ID. Every action returns `200 { "workOrder": … }`.

**Complaint mirror** (what the citizen sees):

| Work order | Complaint |
|---|---|
| PENDING_ASSIGNMENT, ASSIGNED | ASSIGNED |
| ACCEPTED / IN_PROGRESS / BLOCKED | same name (BLOCKED shows as "On hold") |
| RESOLUTION_SUBMITTED / VERIFICATION_REQUIRED | same name |
| COMPLETED | RESOLVED (only after verification) |
| CANCELLED | UNDER_REVIEW (back to triage, department cleared) |

**Work completion is not resolution.** The assignee *submits* a resolution; only a verifier's approval completes the work order and resolves the complaint.

### GET /api/v1/work-orders

| Query | Default | Meaning |
|---|---|---|
| `scope` | `mine` | `mine` = assigned to me (in departments I'm still in); `department` = my departments; `all` = admins only |
| `departmentId` | | With `department`: one of yours (else 403). With `all`: any. |
| `status` | | Comma list, e.g. `ASSIGNED,ACCEPTED` |
| `priority`, `overdue` | | `P1`…`P4`; `overdue=true` |
| `sort` | `dueAt` | `createdAt`, `updatedAt`, `dueAt`, `priority` (prefix `-`) |
| `page`, `limit` | 1, 20 | max 100 |

`GET /api/v1/work-orders/:id` gives the detail. Anyone outside the department (and every citizen) gets `404`.

## 4. Errors

| Status | When |
|---|---|
| 400 | Invalid body, unknown fields, department doesn't handle the category, assignee not an active member |
| 403 | Visible to you but not your action (e.g. a member accepting someone else's work, a manager routing to another department) |
| 404 | Work order or complaint not visible to you |
| 409 | Action not allowed in the current status, or another change happened at the same time |

## 5. Idempotency, concurrency, consistency

- **At most one open work order per complaint**, enforced by a unique database index (`activeFor`). Concurrent or repeated assignment attempts produce exactly one work order; the others get `409`. Automatic routing just stops if one already exists.
- Every transition is a conditional update on the current status (and assignee), so a stale or concurrent request gets `409` instead of overwriting.
- **No multi-document transactions** (local MongoDB is standalone). The work order is written first and the complaint is mirrored second. If the complaint can't follow (it changed concurrently), the work-order change is undone and the caller gets `409`. A crash between the two steps could leave them out of sync. Retry the action, or an admin can cancel and re-route. A replica set plus transactions would close this gap.
- Retrying a failed request is safe: either nothing was saved, or the retry gets `409` with the current state.

## 6. Audit

`assignment.decided` (with source and policy version), `assignment.review_required` (system), and `work_order.<action>` for every transition and `work_order.note_added`. The actor is always the signed-in user, or `SYSTEM` for automatic routing.

## 7. Deferred

- SLA escalation and reminders, workload dashboards (Phase 11).
- Managers handing work to another department directly (by policy, admins only).
