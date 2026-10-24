# Notifications and audit log

Status: **Phase 10, implemented in `server/`.** Conventions: [API_CONVENTIONS.md](API_CONVENTIONS.md).

## 1. In-app notifications

Stored in MongoDB and shown in the app. There is **no email, SMS or push** delivery.

### Endpoints (always the signed-in user's own)

| Method and path | Response |
|---|---|
| `GET /api/v1/notifications?unread=true&page=1&limit=20` | `data`: list, newest first; `meta.pagination` |
| `GET /api/v1/notifications/unread-count` | `{ "count": 3 }` |
| `POST /api/v1/notifications/:id/read` | `{ "id": "…", "read": true }`. Idempotent; someone else's ID returns 404 |
| `POST /api/v1/notifications/read-all` | `{ "updated": 5 }` |

There's no recipient parameter: ownership always comes from the access token.

```json
{
  "id": "6adc…",
  "type": "COMPLAINT_STATUS_CHANGED",
  "title": "CF-2026-00012 is assigned to a team",
  "message": "A department team has been given this work.",
  "complaintPublicId": "CF-2026-00012",
  "workOrderPublicId": null,
  "disputeId": null,
  "readAt": null,
  "createdAt": "2026-10-24T11:02:00.000Z"
}
```

Use `complaintPublicId` / `workOrderPublicId` / `disputeId` to link to the right screen. Show `title` and `message` as plain text (don't render them as HTML).

### Who gets what

| Business event | Recipient | Type |
|---|---|---|
| Complaint created | reporter | `COMPLAINT_RECEIVED` |
| Complaint status changed (any step, including AI review, assignment, work, resolution, reopening, closing, rejection) | reporter | `COMPLAINT_STATUS_CHANGED`. The message is the citizen-facing note only. |
| Case needs a routing decision | platform admins (unrouted) or the department's managers (routed by admin) | `MANAGER_REVIEW_REQUIRED` |
| Work order created with no eligible member | department managers | `MANAGER_REVIEW_REQUIRED` |
| Work order assigned | the assignee | `WORK_ORDER_ASSIGNED` |
| Work order declined, transferred, or blocked | department managers | `WORK_ORDER_UPDATED` |
| Resolution submitted | department managers except the assignee | `VERIFICATION_NEEDED` |
| Verification decided | the assignee | `WORK_ORDER_UPDATED` |
| Dispute created | managers of the complaint's department | `DISPUTE_SUBMITTED` |
| Dispute decided | the reporter | `DISPUTE_DECIDED` |

Rules:
- **Only after success:** notifications are created only after the business action succeeded. Rejected or unauthorized requests never notify anyone.
- **Active accounts only.** Suspended or deactivated users get nothing.
- **No internal details for citizens:** no work notes, staff identities, or other citizens' details.

### Delivery and reliability

- **Synchronous, best-effort, in the same process.** After an action succeeds, its event handlers create notifications before the response is sent.
- **No duplicates:** each notification has a dedupe key (event + recipient) with a unique index, so a repeated event never notifies twice.
- **Failures don't undo anything:** if notification creation fails, it's logged and the business action still succeeds.
- **Not crash-proof:** a server crash between the business write and the notification insert loses that notification. The next step for guaranteed delivery is a transactional outbox (a stored "to notify" record written with the change and processed by the existing background runner). It isn't built.

## 2. Audit log

Every sensitive action writes an append-only `AuditLog` record:
- **Actor:** the signed-in user, `SYSTEM` (rules), or `AI`. Never taken from the request.
- **Also recorded:** action, target, outcome, reason, request ID, and before/after values of changed fields.
- **Never stored:** passwords, tokens or file contents. Control characters in reasons are stripped so they can't forge log lines.
- **Can't be edited:** updates and deletes are blocked at the model level, and there's no API to write, edit or delete records.

**If writing an audit record fails** after the change was saved, the failure is logged at error level with the action and target, and the request still succeeds. (It already happened, and reporting it as failed would be wrong.)

### GET /api/v1/audit-logs (platform admins only; everyone else gets 403)

| Query | Meaning |
|---|---|
| `action` | Exact (`dispute.decided`) or prefix ending with a dot (`work_order.`) |
| `targetType`, `targetId` | e.g. `WorkOrder` + its ID |
| `actorId`, `actorType` | `USER`, `SYSTEM`, `AI` |
| `outcome` | `SUCCESS`, `DENIED`, `FAILED` |
| `from`, `to` | ISO 8601 (UTC); `from` inclusive, `to` exclusive |
| `page`, `limit` | max 100 |

Sorted newest first (`createdAt`, then ID). `GET /api/v1/audit-logs/:id` returns one record.

```json
{ "id": "…", "actorType": "USER", "actorId": "…", "action": "work_order.accept", "targetType": "WorkOrder", "targetId": "…", "outcome": "SUCCESS", "reason": null, "correlationId": "7b2b3cf8-…", "changes": [{ "field": "status", "before": "ASSIGNED", "after": "ACCEPTED" }], "createdAt": "…" }
```

`correlationId` is the request ID (the `X-Request-Id` header), so you can match a record to its server log lines.

### Actions recorded

- **Auth:** `user.registered`, `user.provisioned`, `auth.login_succeeded`, `auth.login_failed` (known accounts only), `auth.logout`, `auth.refresh_token_reused`
- **Profile, departments, memberships:** `user.profile_updated`, `department.created`, `department.updated`, `department.deactivated`, `department.reactivated`, `membership.created`, `membership.reactivated`, `membership.role_changed`, `membership.revoked`
- **Complaints:** `complaint.created`, `complaint.classified`, `complaint.rejected`, `complaint.review_started`, `complaint.closed`
- **Assignment and work:** `assignment.decided`, `assignment.review_required`, `work_order.<every transition>`, `work_order.note_added`
- **Evidence:** `evidence.uploaded`, `evidence.downloaded`
- **Disputes and feedback:** `dispute.created`, `dispute.review_started`, `dispute.decided`, `dispute.withdrawn`, `feedback.created`

Not recorded: failed logins for unknown emails (there's no account to point at; they appear in the server log without the email), and access-denied requests (they appear in the request log with their error code).
