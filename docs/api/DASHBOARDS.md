# Dashboards

Status: **Phase 11, implemented in `server/`.** All endpoints need a bearer token and send `Cache-Control: private, no-store`.

## Time range (all endpoints)

| Query | Meaning |
|---|---|
| `period` | `7d`, `30d` (default), `90d`, `365d`, counting back from now |
| `from`, `to` | ISO 8601 with offset (e.g. `2026-10-01T00:00:00Z`). `from` inclusive, `to` exclusive. Can't be combined with `period`. |

- **Limits:** at most **366 days**. An inverted range or an unknown parameter returns `400`.
- **Timezone:** all boundaries and daily buckets are **UTC**. Each response echoes `range: { from, to }`.
- **What the range affects:** only metrics named `…InRange` (things that happened during the range). Every other count is the **current** state ("how many are open now"). We don't keep historical status snapshots, so "how many were open on 1 Oct" isn't available.

## Metric definitions

| Metric | Definition |
|---|---|
| Active complaints | Status `REPORTED`, `UNDER_REVIEW`, `ASSIGNED`, `ACCEPTED`, `IN_PROGRESS`, `BLOCKED`, `RESOLUTION_SUBMITTED`, `VERIFICATION_REQUIRED` |
| Resolved complaints | `RESOLVED` or `CLOSED` |
| Open work orders | Every work-order status except `COMPLETED` and `CANCELLED` |
| Unassigned | Work orders in `PENDING_ASSIGNMENT` (routed to the department, no team member yet) |
| Overdue | Open work order with `dueAt` in the past. `dueAt` comes from the priority target times in the assignment policy (P1 24 h, P2 72 h, P3 7 d, P4 14 d; pending product-owner approval). |
| Pending verification | Work orders in `RESOLUTION_SUBMITTED` or `VERIFICATION_REQUIRED` |
| Average hours to resolve | Mean of `resolvedAt − createdAt` for complaints **resolved within the range** (1 decimal), `null` if none |
| Awaiting routing | Complaints in `REPORTED`/`UNDER_REVIEW` (admin: with no department yet) |

`byStatus` objects always contain **every** status key (zero if none), so charts don't need to fill gaps. Empty data returns zeros and empty lists, never errors.

## GET /api/v1/dashboard/citizen

Any signed-in user, about **their own** complaints only.

```json
{ "range": { "from": "…", "to": "…" },
  "complaints": { "total": 4, "active": 2, "resolved": 1, "rejected": 1, "byStatus": { "REPORTED": 1, "…": 0 }, "createdInRange": 4 },
  "recent": [{ "publicId": "CF-2026-00012", "title": "…", "status": "IN_PROGRESS", "updatedAt": "…" }],
  "openDisputes": 1, "unreadNotifications": 1 }
```

`recent` has up to 5 entries, most recently updated first.

## GET /api/v1/dashboard/department?departmentId=

For an active member (any role) of that department. `departmentId` can be left out if you belong to exactly one department; otherwise `400`. Anyone else gets `403`.

```json
{ "department": { "id": "…", "name": "Roads" },
  "complaintsByStatus": { "IN_PROGRESS": 1, "…": 0 },
  "myWork": { "byStatus": { "…": 0 }, "open": 2, "awaitingAcceptance": 0, "inProgress": 1, "blocked": 0, "awaitingVerification": 1, "overdue": 0 },
  "departmentOpenWorkOrders": 3,
  "recentActivity": [{ "publicId": "WO-2026-00004", "status": "BLOCKED", "priority": "P3", "overdue": true, "updatedAt": "…" }] }
```

`recentActivity` lists the department's 10 most recently updated work orders.

## GET /api/v1/dashboard/department/manager?departmentId=

For a **manager of that department**, or a platform admin (who must pass `departmentId`). A manager of another department gets `403`.

```json
{ "department": { "id": "…", "name": "Roads", "isActive": true }, "range": { … },
  "complaints": { "byStatus": { … }, "byCategory": { "roads": 5 }, "createdInRange": 4, "awaitingRouting": 0 },
  "workOrders": { "byStatus": { … }, "open": 3, "unassigned": 0, "awaitingAcceptance": 0, "blocked": 1, "overdue": 1, "pendingVerification": 1 },
  "workload": [{ "member": { "id": "…", "name": "Ravi" }, "role": "MEMBER", "openWorkOrders": 2, "overdue": 0 }],
  "openDisputes": 1,
  "resolution": { "resolvedInRange": 1, "averageHoursToResolve": 10 } }
```

`workload` includes every active member (names only, no contact details), busiest first.

## GET /api/v1/dashboard/admin

Platform admins only.

```json
{ "range": { … },
  "complaints": { "byStatus": { … }, "byCategory": { … }, "createdInRange": 7, "intakeByDay": [{ "date": "2026-10-24", "count": 7 }], "awaitingRouting": 1 },
  "workOrders": { "byStatus": { … }, "open": 4, "overdue": 1, "pendingVerification": 1, "bySource": { "AUTO": 1, "MANAGER": 0 } },
  "departments": [{ "id": "…", "name": "Roads", "isActive": true, "openWorkOrders": 3, "overdue": 1 }],
  "disputes": { "open": 1 },
  "resolution": { "resolvedInRange": 1, "averageHoursToResolve": 10 },
  "ai": { "classificationsInRange": { "PENDING": 0, "RUNNING": 0, "SUCCEEDED": 1, "FAILED": 0, "INVALID_OUTPUT": 0 }, "autoAssignedInRange": 1 } }
```

`intakeByDay` only lists days that had complaints (UTC dates). `bySource` only lists sources that occur.

## Errors

`400` (invalid range, unknown parameter, missing `departmentId` when it's ambiguous), `401`, `403` (not a member, manager or admin as required), `404` (department doesn't exist).

## Limitations

- No historical "state on a date" or trend lines of backlog (no status snapshots are stored); no median or percentiles.
- Overdue depends on the provisional target times.
- Metrics are computed live per request with indexed aggregations; there's no caching. Fine at hackathon scale; pre-aggregation would be the next step for large cities.
