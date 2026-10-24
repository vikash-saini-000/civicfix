# Security review (Phase 12)

An internal code review with automated tests, done by the development team. **It is not an external audit or penetration test.** Findings are mapped to the tests that check them.

## Method

1. Read every route, service and model in `server/src` for authentication, authorization, input handling and data exposure.
2. Automated checks: `tests/security.test.ts` checks that **every protected route rejects a request without a token**; plus integration tests for each phase and an end-to-end workflow (`tests/e2e.test.ts`).
3. **Deliberate-breakage checks:** key access rules were temporarily broken to confirm the tests catch it: department scoping for memberships, staff visibility of complaints, retry rules, and duplicate-candidate visibility.
4. `npm audit` (0 vulnerabilities) and a scan of tracked files for credentials (none; the only hit is the fake `hunter2` in a redaction test).

## Findings by area

| Area | Status | Evidence |
|---|---|---|
| Passwords | Argon2id (OWASP parameters); a dummy verify for unknown emails keeps timing equal; generic login errors | `auth.test.ts` |
| Tokens and sessions | 15-minute HS256 JWT holding IDs only. Session, account and roles are re-checked on every request. Refresh token rotates, and reuse revokes the session. Logout is immediate. | `auth.test.ts` |
| CSRF | Cookie endpoints require the `X-Requested-With` header and an allowed `Origin`; the cookie is SameSite and path-limited | `auth.test.ts` |
| Object-level authorization | Complaints, work orders, evidence, disputes and notifications are checked per resource. Not-visible returns 404 (hides existence). Department scope comes from stored memberships. | `complaints`, `workOrders`, `resolution`, `notifications` tests |
| Function-level authorization | Admin-only and manager-only actions, deny by default; a misspelled role makes the server refuse to start | `auth`, `departments`, `security` tests |
| Mass assignment and identity spoofing | Strict zod schemas reject unknown fields (role, status, actor, source, recipient…). Identity only comes from the token. | every phase's tests |
| State transitions | Explicit tables for complaints and work orders; atomic conditional updates; races return 409 | `workOrders`, `resolution` tests |
| Input validation | IDs, enums, lengths, coordinates, pagination (≤100), date ranges (≤366 days), body size (100 kB JSON) | `conventions`, `dashboards`, `security` tests |
| Errors | No stack traces or internal messages in production; database errors mapped to safe codes | `conventions`, `security` tests |
| Headers and CORS | Helmet (HSTS, CSP, nosniff…), no `x-powered-by`, exact-origin CORS | `app`, `security` tests |
| Uploads | Real type from the file's bytes must match the declared type; size limits; server-generated keys; no path traversal; storage keys never returned; downloads access-checked, audited and `no-store` | `resolution.test.ts` |
| AI | Output is untrusted and schema-validated; prompt injection mitigated (data in tags, no tools, can only pick offered codes); minimal data sent; never auto-assigns, rejects or resolves on its own; failures go to manual triage | `analysis`, `workOrders`, `e2e` tests |
| Logging | JSON logs with request IDs; auth headers, cookies, tokens, passwords, keys and URIs are redacted; no request bodies or complaint text in logs | `app`, `auth`, `analysis` tests |
| Audit | Append-only (update and delete blocked); actor from the session; control characters stripped; admin-only read API, no write API | `database`, `notifications` tests |
| Rate limits | Login (per IP and per IP + email), register, refresh, complaint creation, AI re-runs, uploads | `auth`, `complaints` tests |

## Open risks and recommendations

1. **No multi-document transactions** (local MongoDB is a single server). The order of writes plus undo steps limits inconsistency, but a crash mid-operation can leave a complaint and its work order out of step. → Run a replica set and use transactions in `workOrders.ts` `transition` / `createWorkOrder`.
2. **Rate limits are per process** → use a shared store when scaling out.
3. **Upload content isn't virus-scanned**, and C2PA content credentials aren't cryptographically verified. Files are never executed or transformed. → Add a scanning step before making evidence downloadable.
4. **Notifications can be lost** if the server crashes between a business write and the notification insert → a transactional outbox.
5. **Account enumeration via `register` (409)** is a known trade-off until email verification exists. No email verification or password reset yet.
6. **Some list endpoints make several queries per item** (work-order list views, department dispute scope with up to 5,000 work orders). Fine at demo scale → batch lookups and paginate the inner scope at city scale.
7. **The AI has only been tested against simulated responses** → run a live check and review a sample of real outputs before relying on automatic routing.
8. **Policy values need product-owner sign-off:** target times, auto-assignment, auto-approval (off), dispute window, and staff-pick workload cap.
