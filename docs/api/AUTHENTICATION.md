# CivicFix authentication

Status: **Phase 4, implemented in `server/`.** General response and error conventions: [API_CONVENTIONS.md](API_CONVENTIONS.md).

Not tested against the real frontend yet: `client/` still runs on mock data.

## How it works

| Piece | What | Where it lives |
|---|---|---|
| **Access token** | JWT (HS256), valid **15 minutes** | Response body. Keep it **in memory only** (a JS variable or React state), not `localStorage`. Send it as `Authorization: Bearer <token>`. |
| **Refresh token** | Random 256-bit opaque token, valid **7 days** from sign-in (not extended by refreshing) | `HttpOnly` cookie `civicfix_refresh`, path `/api/v1/auth`, `SameSite=Lax`, `Secure` in production. JavaScript can't read it, and the browser sends it only to auth endpoints. |

Why this design: the separate frontend gets a simple bearer header for every API call, while the long-lived credential stays out of reach of JavaScript (and XSS). Each access token is tied to a server-side session, and **every request re-checks the session, the account status and the user's roles in the database**, so:

- **Logout takes effect immediately**: the access token and refresh token stop working at once.
- Suspending an account, removing a department membership, or changing a role takes effect on the next request, without waiting for the token to expire.
- Roles are **never** read from the token or the request; they come from stored records.

Refresh tokens are **rotated**: each refresh returns a new cookie, and the old one becomes invalid. If an old refresh token is ever used again (a sign of theft), the whole session is revoked and the user has to sign in again.

## Endpoints

All live under `/api/v1/auth`. Bodies are JSON (`Content-Type: application/json`); responses use the standard envelope.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /register` | none | Create a **citizen** account and sign in |
| `POST /login` | none | Sign in |
| `POST /refresh` | refresh cookie + `X-Requested-With: civicfix` | Get a new access token (and rotated cookie) |
| `POST /logout` | refresh cookie and/or bearer token + `X-Requested-With: civicfix` | End this session |
| `GET /me` | bearer token | Current user |

### POST /register

```json
{ "name": "Asha Rao", "email": "asha@example.com", "password": "at least 8 characters" }
```

| Field | Rules |
|---|---|
| `name` | 1–100 characters, trimmed |
| `email` | Valid email, max 254, trimmed and lower-cased; must be unused |
| `password` | 8–128 characters, used exactly as typed (not trimmed). Long passphrases are encouraged; no composition rules. |

Any other field (`platformRole`, `role`, `accountStatus`, `department`, …) is rejected with `400` (`unrecognized_key`). Every new account is an active `CITIZEN`.

`201 Created`, with `Set-Cookie: civicfix_refresh=…` and `Cache-Control: no-store`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "6adc7d295671c757afb5da30",
      "name": "Asha Rao",
      "email": "asha@example.com",
      "platformRole": "CITIZEN",
      "roles": ["CITIZEN"],
      "memberships": [],
      "createdAt": "2026-10-24T09:41:00.000Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "expiresAt": "2026-10-24T09:56:00.000Z"
  }
}
```

Errors: `400 VALIDATION_ERROR`, `409 CONFLICT` (`details: [{ "field": "body.email", "issue": "duplicate" }]`), `429 RATE_LIMITED`.

### POST /login

```json
{ "email": "asha@example.com", "password": "…" }
```

`200` with the same body and cookie as register.

A wrong password, an unknown email and a suspended or deactivated account all return the **same** response, so it can't reveal whether an account exists:

```json
{ "success": false, "error": { "code": "INVALID_CREDENTIALS", "message": "The email or password is incorrect.", "details": [] }, "requestId": "…" }
```

### POST /refresh

No body. The browser sends the cookie automatically if the request uses `credentials: 'include'`. **Required header:** `X-Requested-With: civicfix`.

`200` with the same body as login (fresh `accessToken`, current `user`) and a new cookie. `401 UNAUTHENTICATED` (and the cookie cleared) if the session is missing, expired, revoked or reused. Then send the user to the sign-in screen.

### POST /logout

No body. **Required header:** `X-Requested-With: civicfix`. Send the cookie (`credentials: 'include'`) and, if you have one, the bearer token. Either is enough, so logout works even after the access token has expired.

Always returns `204` and clears the cookie, even if the session was already gone. Only this device's session ends; other devices stay signed in.

### GET /me

`Authorization: Bearer <accessToken>` → `200 { "success": true, "data": { "user": { …same fields as above… } } }`.

`user.roles` is what the UI should use to decide what to show:

| Role | Comes from |
|---|---|
| `CITIZEN` | Default platform role |
| `PLATFORM_ADMIN` | Platform role set by an administrator |
| `DEPARTMENT_MEMBER` / `DEPARTMENT_MANAGER` | An active membership in an active department; `memberships` lists them as `{ departmentId, role: "MEMBER" \| "MANAGER" }` |

Hiding buttons is only a convenience. The server checks every permission itself.

## Errors

| Status | `error.code` | Meaning | Frontend action |
|---|---|---|---|
| 401 | `UNAUTHENTICATED` | Missing, invalid or expired access token, or a revoked session. Response has `WWW-Authenticate: Bearer…` | Call `/refresh` once, retry the request; if refresh fails, go to sign-in |
| 401 | `INVALID_CREDENTIALS` | Login failed | Show the message |
| 403 | `FORBIDDEN` | Signed in but not allowed, or a missing CSRF header / untrusted origin on refresh or logout | Don't retry |
| 429 | `RATE_LIMITED` | Too many attempts (see `RateLimit` headers) | Ask the user to wait |

## Frontend flow

1. **App start:** call `POST /refresh` (with `credentials: 'include'` and the header). `200` means the user is signed in; keep `accessToken` and `user` in memory. `401` means signed out.
2. **API calls:** send `Authorization: Bearer <accessToken>`. Refresh shortly before `expiresAt`, or on a `401 UNAUTHENTICATED`; then retry **once**.
3. **Only one refresh at a time:** share one in-flight refresh promise across the app (and ideally across tabs). Two parallel refreshes with the same cookie look like token reuse and sign the user out.
4. **Sign out:** `POST /logout`, then drop the in-memory token.

```ts
const API = 'http://localhost:4000/api/v1';
const res = await fetch(`${API}/auth/refresh`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'X-Requested-With': 'civicfix' },
});
```

## CSRF and CORS

- Only `/refresh` and `/logout` use the cookie. They require `X-Requested-With: civicfix`, which a browser can't send cross-site without a CORS preflight, and they reject any `Origin` not in the server's `CORS_ORIGINS`. The cookie is also `SameSite=Lax` and limited to `/api/v1/auth`.
- All other endpoints use the bearer header, which browsers never attach automatically, so they aren't exposed to CSRF.
- The frontend origin must be listed in the server's `CORS_ORIGINS` (local: `http://localhost:5173`), and auth requests must use `credentials: 'include'`.
- Local development: `localhost:5173` and `localhost:4000` count as the same site, so `SameSite=Lax` works. If the frontend and API are deployed on **different sites**, the server needs `COOKIE_SAMESITE=none` and HTTPS.

## Rate limits (per server instance)

| Endpoint | Limit |
|---|---|
| `register` | 10 per hour per IP |
| `login` | 50 per 15 min per IP, and 10 per 15 min per IP + email |
| `refresh` | 60 per 15 min per IP |

There is no account lockout: per-account lockouts let anyone lock out someone else.

## Staff and admin accounts

Public registration only creates citizens. Platform admins are created from the server:

```bash
cd server
NEW_USER_PASSWORD='…' npm run user:create -- --email admin@example.org --name "Admin" --role PLATFORM_ADMIN
```

Department memberships (member and manager roles) will be managed through the department APIs in Phase 5.

## Not implemented yet

- **Email verification:** emails aren't confirmed, so registering doesn't prove you own the address.
- **Password reset and change:** there's no "forgot password" flow and no endpoint to change a password.
- **Sign out everywhere,** or listing a user's active sessions.
- **Multi-factor authentication.**
- **Shared rate-limit store:** limits are per process; a multi-instance deployment needs a shared store.
- **Account enumeration:** register returns `409` for a used email, which reveals that the account exists; login doesn't. Fixing it needs email verification.
