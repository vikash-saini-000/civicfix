# CivicFix API conventions

Status: **Phase 6**. These conventions are implemented in `server/`. Implemented endpoints: health checks, authentication ([AUTHENTICATION.md](AUTHENTICATION.md)), users, departments and memberships ([USERS_DEPARTMENTS_MEMBERSHIPS.md](USERS_DEPARTMENTS_MEMBERSHIPS.md)), and complaints ([COMPLAINTS.md](COMPLAINTS.md)). Each future endpoint will be documented in this folder as it ships (see [Documenting endpoints](#documenting-endpoints)).

## 1. Base path and versioning

| | |
|---|---|
| Product API | `/api/v1/...` (local: `http://localhost:4000/api/v1`) |
| Infrastructure | `/health/live`, `/health/ready` (unversioned, own format, see §9) |

- Breaking changes go to a new prefix (`/api/v2`); additive changes (new fields, new endpoints) stay in `v1`. Clients must ignore unknown response fields.
- Paths are lower-case, plural nouns, kebab-case: `/api/v1/complaints`, `/api/v1/work-orders/:id`.
- Resource IDs in paths are MongoDB IDs (24 hex chars), except complaints, which can also be addressed by public ID (`CF-2026-00141`, case-insensitive).
- State changes are explicit actions, not generic status patches: `POST /api/v1/work-orders/:id/accept`, not `PATCH {status: "ACCEPTED"}`.

## 2. Content types

- Requests with a body (`POST`, `PUT`, `PATCH`) must send `Content-Type: application/json` (UTF-8). Anything else gets **415 `UNSUPPORTED_MEDIA_TYPE`**. File uploads (later phase) will use a dedicated endpoint and will be documented separately.
- Max JSON body: **100 kB** by default (server setting `JSON_BODY_LIMIT`). Larger gets **413 `PAYLOAD_TOO_LARGE`**.
- Bodies must be JSON objects. Unknown fields are **rejected, not ignored** (see §4).
- All responses are `application/json; charset=utf-8`, except `204 No Content`.
- Timestamps are ISO 8601 UTC strings, e.g. `"2026-10-24T09:05:38.359Z"`.

## 3. Response envelope

**Success**

```json
{
  "success": true,
  "data": { "...": "..." },
  "meta": { "pagination": { "page": 1, "limit": 20, "total": 45, "totalPages": 3, "hasNextPage": true } }
}
```

`meta` is present only when there is something to put in it (e.g. pagination on list endpoints). `data` is an object for single resources and an array for lists.

**Error**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid fields.",
    "details": [
      { "field": "body.title", "issue": "too_small", "message": "Too small: expected string to have >=5 characters" }
    ]
  },
  "requestId": "7b2b3cf8-3267-47e4-a1e2-9c7da5a065d2"
}
```

- Branch on `error.code`, never on `message`. `message` is safe to show but may change wording.
- `details` is always an array (empty when not field-specific).
- `requestId` equals the `X-Request-Id` response header.

## 4. Validation errors

Every problem in the request is reported at once, as one `400 VALIDATION_ERROR`.

| `details[].field` | Meaning |
|---|---|
| `body.title` | Field in the JSON body (nested: `body.location.lat`) |
| `query.limit` | Query-string parameter |
| `params.id` | Path parameter |

Common `issue` values: `invalid_type`, `too_small`, `too_big`, `invalid_format`, `invalid_value` (e.g. not in an enum), `custom`, `unrecognized_key` (a field that isn't allowed), `duplicate` (on 409), `invalid` (server-side model rule).

**Unknown fields are rejected.** Sending fields the endpoint doesn't accept, including privileged ones like `role`, `citizen`, `status` or `department`, returns:

```json
{ "field": "body.role", "issue": "unrecognized_key", "message": "This field is not allowed." }
```

Ownership, roles, department and assignment are always taken from the logged-in user and stored records, never from the request.

Strings are trimmed where the endpoint documents it; complaint public IDs are upper-cased. No other silent normalization.

## 5. Status codes

| Status | `error.code` | When |
|---|---|---|
| 200 | | OK (read, or action with a result) |
| 201 | | Created; `Location` header points at the new resource |
| 204 | | Done, no body (e.g. delete) |
| 400 | `VALIDATION_ERROR` | Invalid fields, params, query or IDs |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 401 | `UNAUTHENTICATED` | Missing, invalid or expired access token (see [AUTHENTICATION.md](AUTHENTICATION.md)) |
| 401 | `INVALID_CREDENTIALS` | Login with a wrong email or password |
| 403 | `FORBIDDEN` | Signed in but not allowed |
| 404 | `NOT_FOUND` | Unknown route or resource (also used when a resource exists but you may not see it) |
| 409 | `CONFLICT` | Unique value already used, or action not allowed in the current state |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body not `application/json` (or unsupported charset/encoding) |
| 429 | `RATE_LIMITED` | Too many requests on a rate-limited route; see `RateLimit` / `RateLimit-Policy` headers |
| 500 | `INTERNAL_ERROR` | Unexpected server error. Generic message; quote `requestId` when reporting |
| 503 | `SERVICE_UNAVAILABLE` | Database down or server restarting. `Retry-After: 5`; safe to retry |

## 6. Request IDs

- Every response has an `X-Request-Id` header (also readable from browser JS via CORS).
- A client may send its own `X-Request-Id`. It is reused if it is 8–64 characters of `A–Z a–z 0–9 . _ -`; otherwise the server generates a UUID.
- When reporting a bug, include the `requestId`; it finds the exact server log lines.

## 7. Pagination, sorting, filtering

List endpoints accept:

| Param | Default | Rules |
|---|---|---|
| `page` | `1` | Whole number 1–10000 |
| `limit` | `20` | Whole number 1–100 |
| `sort` | per endpoint (e.g. `-createdAt`) | One field from the endpoint's allowlist; prefix `-` for descending |

- Values must be plain digits: `0`, `-1`, `1.5`, `1e3`, `+2`, repeated params (`page=1&page=2`) and unknown params are rejected with 400.
- Filters are endpoint-specific query params (e.g. `status=ASSIGNED`) and are documented per endpoint.
- Response: `data` is the array for the page; `meta.pagination` is `{ page, limit, total, totalPages, hasNextPage }`. A page past the end returns `data: []` with `200`.

## 8. CORS and credentials

- Only origins listed in the server's `CORS_ORIGINS` may call the API from a browser (local frontend: `http://localhost:5173`). There is no wildcard.
- Credentials (cookies) are allowed for those origins. Only the auth refresh cookie uses them; see [AUTHENTICATION.md](AUTHENTICATION.md).
- Preflight results are cached for 10 minutes.

## 9. Health endpoints

Used by uptime checks and deploy tooling, not by the app UI. They keep a small, fixed format instead of the envelope.

| Request | Response |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}` |
| `GET /health/ready` | `200 {"status":"ready","checks":{"database":"up"}}` or `503 {"status":"not_ready","checks":{"database":"down"}}` |

## 10. Examples (current behaviour)

Unknown route:

```http
GET /api/v1/complaints HTTP/1.1

HTTP/1.1 404 Not Found
X-Request-Id: ad1f58ff-41f1-4470-a3f1-b8a7cf958ed3

{"success":false,"error":{"code":"NOT_FOUND","message":"No route for GET /api/v1/complaints.","details":[]},"requestId":"ad1f58ff-41f1-4470-a3f1-b8a7cf958ed3"}
```

Malformed JSON:

```http
POST /api/v1/anything HTTP/1.1
Content-Type: application/json

{"title":

HTTP/1.1 400 Bad Request
{"success":false,"error":{"code":"INVALID_JSON","message":"The request body is not valid JSON.","details":[]},"requestId":"…"}
```

Wrong content type:

```http
POST /api/v1/anything HTTP/1.1
Content-Type: text/plain

HTTP/1.1 415 Unsupported Media Type
{"success":false,"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Send the request body as application/json.","details":[]},"requestId":"…"}
```

Database down:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5
{"success":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"The service is temporarily unavailable. Try again shortly.","details":[]},"requestId":"…"}
```

## Documenting endpoints

Each feature phase adds a file here (e.g. `docs/api/complaints.md`) with, per endpoint:

1. Method and path, and who may call it.
2. Path params, query params (filters, sort allowlist, pagination) and body fields: type, required or optional, limits, enum values.
3. Success status and a full example response.
4. Error codes it can return beyond the common ones, with the reason.
5. Side effects (status changes, notifications).

Only endpoints that exist in `server/` are documented as available.
