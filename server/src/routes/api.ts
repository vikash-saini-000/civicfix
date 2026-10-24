import { Router } from 'express';
import { authRouter, type AuthRouterDeps } from './auth.js';

export type ApiDeps = AuthRouterDeps;

/**
 * The /api/v1 router. Feature routers are mounted here as phases add them.
 *
 * Per-route middleware order (convention):
 *   [rate limit] → requireAuth(authService) → requireRole(...) / requireDepartmentRole(...)
 *   → validate({ params, query, body }) → handler
 * Handlers read input only from req.validated and identity only from req.auth, and respond with
 * sendSuccess / sendCreated or throw AppError. Ownership, role, department and assignment come
 * from req.auth and stored records, never from request fields. Resource-level checks (e.g. "is this
 * my complaint") belong in the feature's service, on top of these role guards.
 */
export function apiRouter(deps: ApiDeps): Router {
  const router = Router();
  router.use('/auth', authRouter(deps));
  return router;
}
