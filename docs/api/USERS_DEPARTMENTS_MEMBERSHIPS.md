# Users, departments and memberships

Status: **Phase 5, implemented in `server/`.** All endpoints need `Authorization: Bearer <accessToken>` (see [AUTHENTICATION.md](AUTHENTICATION.md)). Envelope, errors and pagination follow [API_CONVENTIONS.md](API_CONVENTIONS.md).

## Roles and memberships

| Concept | Meaning |
|---|---|
| **User** | A person's account. `platformRole` is `CITIZEN` (everyone) or `PLATFORM_ADMIN` (set only by a server-side script). |
| **Department** | A municipal team that handles one or more complaint categories (`roads`, `garbage`, `streetlight`, `water`, `drainage`, `other`). Active or inactive. |
| **Membership** | Links a user to a department with a department role: `MEMBER` or `MANAGER`, and a status: `ACTIVE` or `INACTIVE` (revoked). A user can be in several departments. |

`user.roles` (from `/users/me`) combines both: `CITIZEN` or `PLATFORM_ADMIN`, plus `DEPARTMENT_MEMBER` and/or `DEPARTMENT_MANAGER` if the user has an **active** membership in an **active** department. `user.memberships` lists those as `{ departmentId, role }`. Revoked memberships and memberships in inactive departments grant nothing, from the very next request.

A membership never grants `PLATFORM_ADMIN`, and being a manager in one department gives no rights in another.

## Who can do what

| Action | Platform admin | Manager of **that** department | Member / other manager / citizen |
|---|---|---|---|
| Read own profile, change own name | ✓ | ✓ | ✓ |
| List / read active departments | ✓ | ✓ | ✓ |
| List / read **inactive** departments | ✓ | ✗ | ✗ (inactive ones are 404) |
| Create, edit, deactivate, reactivate department | ✓ | ✗ | ✗ |
| List the department's members | ✓ | ✓ | ✗ (403) |
| Add a `MEMBER` (or reactivate one) | ✓ | ✓ | ✗ |
| Add or reactivate a `MANAGER` | ✓ | ✗ | ✗ |
| Change a membership's role | ✓ | ✗ | ✗ |
| Revoke a `MEMBER` | ✓ | ✓ (not themselves) | ✗ |
| Revoke a `MANAGER` | ✓ | ✗ | ✗ |

Permission is always checked against the department in the URL, using the caller's stored memberships. Failed checks return `403 FORBIDDEN` and change nothing.

**Trusted provisioning only:** platform admins are created with `npm run user:create` on the server (see AUTHENTICATION.md). The first manager of a department is appointed by a platform admin.

---

## User profile

### GET /api/v1/users/me

`200`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "6adc806b7815ccac1fac5a40",
      "name": "Ravi",
      "email": "ravi@example.com",
      "platformRole": "CITIZEN",
      "roles": ["CITIZEN", "DEPARTMENT_MANAGER"],
      "memberships": [{ "departmentId": "6adc806b7815ccac1fac5a43", "role": "MANAGER" }],
      "createdAt": "2026-10-24T10:02:51.000Z"
    }
  }
}
```

Same shape as `GET /api/v1/auth/me`.

### PATCH /api/v1/users/me

```json
{ "name": "Ravi Kumar" }
```

| Field | Rules |
|---|---|
| `name` | 1–100 characters, trimmed |

Only `name` can be changed here. Any other field (`email`, `platformRole`, `accountStatus`, `roles`, `memberships`, …) is rejected with `400` (`unrecognized_key`), and nothing is saved. An empty body is `400`. `200` returns the updated `user`.

---

## Departments

Department object:

```json
{
  "id": "6adc806b7815ccac1fac5a43",
  "name": "Roads and Public Works",
  "description": null,
  "categories": ["roads", "drainage"],
  "isActive": true,
  "createdAt": "2026-10-24T10:02:51.000Z",
  "updatedAt": "2026-10-24T10:02:51.000Z"
}
```

### GET /api/v1/departments

Any signed-in user. Paginated; `data` is an array and `meta.pagination` is included.

| Query | Default | Notes |
|---|---|---|
| `page`, `limit` | `1`, `20` | `limit` max 100 |
| `sort` | `name` | `name`, `createdAt`; prefix `-` for descending |
| `category` | none | One category; departments handling it |
| `includeInactive` | `false` | `true` is for platform admins only (others get 403) |

### GET /api/v1/departments/:departmentId

Any signed-in user for active departments. Inactive ones return `404` unless you're a platform admin. `200 { "data": { "department": { … } } }`.

### POST /api/v1/departments (platform admin)

```json
{ "name": "Streetlights", "description": "Optional, up to 1000 chars", "categories": ["streetlight"] }
```

| Field | Rules |
|---|---|
| `name` | 2–100 characters, unique (case-insensitive) |
| `description` | Optional, up to 1000 characters |
| `categories` | 1–6 distinct values from the list above. Two departments may share a category. |

`201` with `Location` header and `{ "department": … }`. `409 CONFLICT` if the name is taken (`details[0].field = "body.name"`). `isActive` and other fields are rejected.

### PATCH /api/v1/departments/:departmentId (platform admin)

Any subset of `name`, `description`, `categories` (same rules). `200 { "department": … }`.

### POST /api/v1/departments/:departmentId/deactivate and /reactivate (platform admin)

Optional body `{ "reason": "Merged into Public Works" }` (stored in the audit log). `200 { "department": … }`. Calling either one when the department is already in that state just returns it.

Deactivation:
- **Keeps** the department, its memberships and its history. Nothing is deleted.
- Its memberships stop granting any rights immediately, and members can't be added until it is reactivated (`409`).
- It disappears from non-admin lists and reads.
- It is **refused with `409 CONFLICT` while the department has open work orders** (any status except completed or cancelled).

Reactivation restores the existing memberships as they were.

---

## Memberships

Membership object:

```json
{
  "id": "6adc806c7815ccac1fac5a45",
  "departmentId": "6adc806b7815ccac1fac5a43",
  "user": { "id": "6adc806b7815ccac1fac5a40", "name": "Ravi", "email": "ravi@example.com" },
  "role": "MANAGER",
  "status": "ACTIVE",
  "createdAt": "2026-10-24T10:02:52.000Z",
  "updatedAt": "2026-10-24T10:02:52.000Z"
}
```

### GET /api/v1/departments/:departmentId/members (admin, or manager of this department)

| Query | Default | Notes |
|---|---|---|
| `page`, `limit` | `1`, `20` | `limit` max 100 |
| `sort` | `createdAt` | `createdAt`, `role` |
| `status` | `ACTIVE` | `ACTIVE`, `INACTIVE`, `ALL` |
| `role` | none | `MEMBER` or `MANAGER` |

### POST /api/v1/departments/:departmentId/members

Identify the user by **exactly one** of `userId` or `email`:

```json
{ "email": "ravi@example.com", "role": "MEMBER" }
```

| Field | Rules |
|---|---|
| `userId` / `email` | Exactly one. The account must exist and be active. |
| `role` | `MEMBER` (default) or `MANAGER`. Managers may only add `MEMBER`s. |

Results:
- `201` with `{ "membership": … }` for a new membership.
- `200` with the same membership if the user had a **revoked** membership in this department. It's reactivated (same `id`) with the requested role.
- `404` if no active account matches, or the department doesn't exist.
- `409` if the user is already an active member, or the department is inactive.
- `403` if the caller lacks permission (including a manager asking for `MANAGER`).

### PATCH /api/v1/departments/:departmentId/members/:membershipId (platform admin)

```json
{ "role": "MANAGER" }
```

Promotes or demotes. `200 { "membership": … }`. `404` if the membership isn't in this department. `409` if it's revoked (add the user again to reactivate it).

### DELETE /api/v1/departments/:departmentId/members/:membershipId

Revokes the membership: it sets `status` to `INACTIVE` and **keeps the record**. Optional JSON body `{ "reason": "Transferred" }`. `200 { "membership": … }` with `status: "INACTIVE"`. Revoking an already revoked membership returns it unchanged.

Managers may revoke `MEMBER`s of their own department but not themselves or other managers (`403`). The revoked user loses department access on their next request; their tokens don't need to expire first.

---

## Errors you may see

| Status | Code | Typical cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad ID format (`params.departmentId`), unknown field, bad enum, `limit` > 100 |
| 401 | `UNAUTHENTICATED` | Missing or expired access token |
| 403 | `FORBIDDEN` | Not allowed for this department or action |
| 404 | `NOT_FOUND` | Department, membership or active account not found (also an inactive department for non-admins) |
| 409 | `CONFLICT` | Duplicate name or membership, department inactive or has open work, revoked membership |

## Audit trail

Every change writes an audit entry with the actor, target, request ID and before/after values:
- `user.profile_updated`
- `department.created`, `department.updated`, `department.deactivated`, `department.reactivated`
- `membership.created`, `membership.reactivated`, `membership.role_changed`, `membership.revoked`

There is no API for reading audit entries yet (later phase).

## Not implemented / open policy

- **Email changes** need email verification (not built); **account suspension** and **admin user search or listing** have no API yet.
- **Managers can look users up by email** when adding them. This reveals whether an email has an active account to staff users. Accepted for now; revisit if needed.
- **Only admins appoint managers**, and nothing stops a department from having zero managers. The blueprint doesn't define a manager-appointment policy beyond this.
- Members can't see their colleagues' list. Revisit when work-order reassignment needs it (Phase 8).
