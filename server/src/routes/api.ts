import { Router } from 'express';
import type { RateLimitOptions } from '../middleware/rateLimit.js';
import type { AnalysisService } from '../services/analysis/index.js';
import { createComplaintService } from '../services/complaints.js';
import { createDepartmentService } from '../services/departments.js';
import { createMembershipService } from '../services/memberships.js';
import { createUserService } from '../services/users.js';
import { authRouter, type AuthRouterDeps } from './auth.js';
import { complaintsRouter } from './complaints.js';
import { departmentsRouter } from './departments.js';
import { usersRouter } from './users.js';

export type ApiDeps = AuthRouterDeps & {
  analysisService: AnalysisService;
  complaintCreateLimit?: RateLimitOptions;
  analysisRerunLimit?: RateLimitOptions;
  onHookError?: (err: unknown) => void;
};

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
  const { authService } = deps;
  router.use('/auth', authRouter(deps));
  router.use('/users', usersRouter({ authService, userService: createUserService(authService) }));
  router.use(
    '/departments',
    departmentsRouter({ authService, departmentService: createDepartmentService(), membershipService: createMembershipService() }),
  );
  const { analysisService } = deps;
  const complaintService = createComplaintService({
    onCreated: (id) => analysisService.queueForNewComplaint(id),
    onHookError: (err) => deps.onHookError?.(err),
  });
  router.use(
    '/complaints',
    complaintsRouter({
      authService,
      complaintService,
      analysisService,
      createLimit: deps.complaintCreateLimit,
      rerunLimit: deps.analysisRerunLimit,
    }),
  );
  return router;
}
