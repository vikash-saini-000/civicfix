import { Router } from 'express';
import type { VideoTools } from '../media/video.js';
import type { Types } from 'mongoose';
import type { EventBus } from '../events/bus.js';
import type { RateLimitOptions } from '../middleware/rateLimit.js';
import type { AnalysisService } from '../services/analysis/index.js';
import { createComplaintService } from '../services/complaints.js';
import { createDepartmentService } from '../services/departments.js';
import { createEvidenceService } from '../services/evidence.js';
import { createMembershipService } from '../services/memberships.js';
import { createNotificationService } from '../services/notifications.js';
import { createDashboardService } from '../services/dashboards.js';
import { createResolutionService, type VerificationPolicy } from '../services/resolution.js';
import { createUserService } from '../services/users.js';
import { createWorkOrderService, type AssignmentPolicy } from '../services/workOrders.js';
import { disabledStorage, type ObjectStorage } from '../storage/index.js';
import type { Logger } from '../utils/logger.js';
import { safeError } from '../config/database.js';
import { authRouter, type AuthRouterDeps } from './auth.js';
import { complaintsRouter } from './complaints.js';
import { departmentsRouter } from './departments.js';
import { evidenceUploadRouter, resolutionRouter } from './resolution.js';
import { auditLogsRouter, notificationsRouter } from './notifications.js';
import { dashboardsRouter } from './dashboards.js';
import { analyticsRouter, geoRouter } from './analytics.js';
import { createAnalyticsService } from '../services/analytics.js';
import { usersRouter } from './users.js';
import { assignmentsRouter, workOrdersRouter } from './workOrders.js';

export type ApiDeps = AuthRouterDeps & {
  analysisService: AnalysisService;
  complaintCreateLimit?: RateLimitOptions;
  analysisRerunLimit?: RateLimitOptions;
  uploadLimit?: RateLimitOptions;
  onHookError?: (err: unknown) => void;
  events: EventBus;
  logger: Logger;
  assignmentPolicy?: AssignmentPolicy;
  verificationPolicy?: VerificationPolicy;
  storage?: ObjectStorage;
  video?: VideoTools;
  maxVideoSeconds?: number;
};

/**
 * Builds the /api/v1 routers. `uploads` takes raw file bodies and is mounted before the JSON-only
 * check; `router` holds everything else.
 *
 * Per-route middleware order (convention):
 *   [rate limit] → requireAuth(authService) → requireRole(...) / requireDepartmentRole(...)
 *   → validate({ params, query, body }) → handler
 * Handlers read input only from req.validated and identity only from req.auth, and respond with
 * sendSuccess / sendCreated or throw AppError. Ownership, role, department and assignment come
 * from req.auth and stored records, never from request fields. Resource-level checks (e.g. "is this
 * my complaint") belong in the feature's service, on top of these role guards.
 */
export function buildApi(deps: ApiDeps): { router: Router; uploads: Router } {
  const router = Router();
  const { authService, analysisService, events, logger } = deps;
  const storage = deps.storage ?? disabledStorage;

  // workOrderService is created below; the hook only runs later, at request time.
  let reevaluate: (id: Types.ObjectId) => Promise<unknown> = async () => undefined;
  const complaintService = createComplaintService({
    onCreated: (id) => analysisService.queueForNewComplaint(id),
    onFollowUpAnswered: (id) => analysisService.queueAfterFollowUp(id),
    onUnlinked: (id) => reevaluate(id),
    onHookError: (err) => deps.onHookError?.(err),
    events,
  });
  const workOrderService = createWorkOrderService({ logger, events, complaints: complaintService, policy: deps.assignmentPolicy });
  reevaluate = (id) => workOrderService.evaluateAutoAssignment(id);
  const evidenceService = createEvidenceService({
    storage,
    complaints: complaintService,
    queueAnalysis: (complaintId, evidenceId, by, purpose, mediaType, screened) => analysisService.queueForEvidence(complaintId, evidenceId, by, purpose, mediaType, screened),
    screenUpload: (bytes, mediaType, context) => analysisService.screenMedia(bytes, mediaType, context),
    video: deps.video,
    maxVideoSeconds: deps.maxVideoSeconds,
    onQueueError: (err) => logger.error({ err: safeError(err) }, 'evidence analysis could not be queued'),
  });
  const resolutionService = createResolutionService({ events, complaints: complaintService, workOrders: workOrderService, policy: deps.verificationPolicy });

  const notificationService = createNotificationService();
  notificationService.register(events);

  // When AI jobs finish, the deterministic routing rules decide whether to assign automatically.
  analysisService.runner.setJobFinishedHook((id) => workOrderService.evaluateAutoAssignment(id));
  analysisService.runner.setEventBus(events);

  router.use('/auth', authRouter(deps));
  router.use('/users', usersRouter({ authService, userService: createUserService(authService) }));
  router.use('/departments', departmentsRouter({ authService, departmentService: createDepartmentService(), membershipService: createMembershipService() }));
  // Resolution routes share the /complaints and /work-orders prefixes, so they go first.
  router.use(resolutionRouter({ authService, evidenceService, resolutionService }));
  router.use(
    '/complaints',
    complaintsRouter({ authService, complaintService, analysisService, workOrderService, createLimit: deps.complaintCreateLimit, rerunLimit: deps.analysisRerunLimit }),
  );
  router.use('/work-orders', workOrdersRouter({ authService, workOrderService }));
  router.use('/assignments', assignmentsRouter({ authService, workOrderService }));
  router.use('/notifications', notificationsRouter({ authService, notificationService }));
  router.use('/audit-logs', auditLogsRouter({ authService }));
  router.use('/dashboard', dashboardsRouter({ authService, dashboardService: createDashboardService() }));
  router.use('/analytics', analyticsRouter({ authService, analyticsService: createAnalyticsService() }));
  router.use('/geo', geoRouter({ authService }));

  const uploads = evidenceUploadRouter({ authService, evidenceService, uploadLimit: deps.uploadLimit });
  return { router, uploads };
}

/** Backwards-compatible helper returning only the JSON router. */
export function apiRouter(deps: ApiDeps): Router {
  return buildApi(deps).router;
}
