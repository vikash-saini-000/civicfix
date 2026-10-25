import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { disabledCaptcha, requireCaptcha, type CaptchaVerifier } from '../middleware/captcha.js';
import { createRateLimiter, type RateLimitOptions } from '../middleware/rateLimit.js';
import { input, validate } from '../middleware/validate.js';
import { CATEGORIES, COMPLAINT_STATUSES, PRIORITIES } from '../models/enums.js';
import { JOB_TYPES, type AnalysisService, type JobType } from '../services/analysis/index.js';
import type { ClassifyInput, ComplaintService, CreateComplaintInput, ListComplaintsQuery } from '../services/complaints.js';
import type { ManualAssignInput, WorkOrderService } from '../services/workOrders.js';
import { sendCreated, sendSuccess } from '../utils/respond.js';
import { complaintPublicId, objectId, text } from '../validation/common.js';
import { paginationQuery, sortQuery } from '../validation/pagination.js';

// Citizen-submitted fields only. Status, department, priority, confirmed category, reporter and
// anything else are server-controlled; sending them is a 400 (unrecognized_key).
const createBody = z.strictObject({
  title: text(5, 120),
  description: text(10, 2000),
  location: z.strictObject({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  landmark: text(1, 120).optional(),
  selectedCategory: z.enum(CATEGORIES).nullable().optional(),
});

const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(500)
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const listQuery = paginationQuery
  .extend({
    scope: z.enum(['mine', 'department', 'all']).default('mine'),
    sort: sortQuery(['createdAt', 'updatedAt', 'priority'], '-createdAt'),
    status: csvEnum(COMPLAINT_STATUSES).optional(),
    category: z.enum(CATEGORIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    departmentId: objectId.optional(),
    unassigned: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    createdFrom: isoDate.optional(),
    createdTo: isoDate.optional(),
  })
  .refine((q) => !(q.createdFrom && q.createdTo && q.createdFrom >= q.createdTo), {
    message: 'createdFrom must be before createdTo.',
    path: ['createdFrom'],
  })
  .refine((q) => !(q.unassigned && q.departmentId), { message: 'Use either unassigned or departmentId, not both.', path: ['unassigned'] });

const params = z.strictObject({ publicId: complaintPublicId });
const classifyBody = z.strictObject({
  departmentId: objectId,
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).optional(),
  note: text(1, 500).optional(),
});
const rejectBody = z.strictObject({ reason: text(5, 1000) });
// Routing decision. The actor and decision source come from the authenticated user, never from the body.
const assignBody = z.strictObject({
  departmentId: objectId,
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES),
  assigneeId: objectId.optional(),
  reason: text(3, 1000),
});
// One answer per question, in order; an empty string skips a question.
const followUpBody = z.strictObject({ answers: z.array(z.string().trim().max(500)).min(1).max(3) });
const linkDuplicateBody = z.strictObject({ canonicalPublicId: complaintPublicId, reason: text(3, 500) });
const unlinkBody = z.strictObject({ reason: text(3, 500) });
const rerunBody = z.strictObject({
  types: z
    .array(z.enum(JOB_TYPES))
    .min(1)
    .max(JOB_TYPES.length)
    .refine((t) => new Set(t).size === t.length, 'Types must not repeat.')
    .default([...JOB_TYPES]),
});

export interface ComplaintsRouterDeps {
  authService: AuthService;
  complaintService: ComplaintService;
  analysisService: AnalysisService;
  workOrderService: WorkOrderService;
  /** Per-user limit on new complaints. */
  createLimit?: RateLimitOptions;
  /** Per-admin limit on analysis re-runs (each may call the AI provider). */
  rerunLimit?: RateLimitOptions;
  /** Turnstile check on new complaints. Default: disabled. */
  captcha?: CaptchaVerifier;
}

export const DEFAULT_CREATE_LIMIT: RateLimitOptions = { windowMs: 60 * 60_000, limit: 20 };
export const DEFAULT_RERUN_LIMIT: RateLimitOptions = { windowMs: 60 * 60_000, limit: 30 };

/** /api/v1/complaints */
export function complaintsRouter({
  authService,
  complaintService,
  analysisService,
  workOrderService,
  createLimit = DEFAULT_CREATE_LIMIT,
  rerunLimit = DEFAULT_RERUN_LIMIT,
  captcha = disabledCaptcha,
}: ComplaintsRouterDeps): Router {
  const router = Router();
  router.use(requireAuth(authService));
  type Params = z.infer<typeof params>;

  router.post(
    '/',
    createRateLimiter({ ...createLimit, keyPart: (req) => req.auth?.userId }),
    validate({ body: createBody }),
    requireCaptcha(captcha, 'complaint'),
    async (req, res) => {
      const complaint = await complaintService.create(req.auth!, input<CreateComplaintInput>(req, 'body'), req.id);
      sendCreated(res, { complaint }, `/api/v1/complaints/${complaint.publicId}`);
    },
  );

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { items, pagination } = await complaintService.list(req.auth!, input<ListComplaintsQuery>(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });

  router.get('/:publicId', validate({ params }), async (req, res) => {
    sendSuccess(res, { complaint: await complaintService.get(req.auth!, input<Params>(req, 'params').publicId) });
  });

  router.post('/:publicId/classify', validate({ params, body: classifyBody }), async (req, res) => {
    const { publicId } = input<Params>(req, 'params');
    sendSuccess(res, { complaint: await complaintService.classify(req.auth!, publicId, input<ClassifyInput>(req, 'body'), req.id) });
  });

  router.post('/:publicId/reject', validate({ params, body: rejectBody }), async (req, res) => {
    const { publicId } = input<Params>(req, 'params');
    const { reason } = input<{ reason: string }>(req, 'body');
    sendSuccess(res, { complaint: await complaintService.reject(req.auth!, publicId, reason, req.id) });
  });

  router.post('/:publicId/follow-up', validate({ params, body: followUpBody }), async (req, res) => {
    const { publicId } = input<Params>(req, 'params');
    const { answers } = input<{ answers: string[] }>(req, 'body');
    sendSuccess(res, { complaint: await complaintService.answerFollowUp(req.auth!, publicId, answers, req.id) });
  });

  router.post('/:publicId/duplicate-of', validate({ params, body: linkDuplicateBody }), async (req, res) => {
    const { publicId } = input<Params>(req, 'params');
    sendSuccess(res, { complaint: await complaintService.linkDuplicate(req.auth!, publicId, input<{ canonicalPublicId: string; reason: string }>(req, 'body'), req.id) });
  });

  router.post('/:publicId/duplicate-of/remove', validate({ params, body: unlinkBody }), async (req, res) => {
    const { publicId } = input<Params>(req, 'params');
    sendSuccess(res, { complaint: await complaintService.unlinkDuplicate(req.auth!, publicId, input<{ reason: string }>(req, 'body').reason, req.id) });
  });

  router.post('/:publicId/assign', validate({ params, body: assignBody }), async (req, res) => {
    const { publicId } = input<Params>(req, 'params');
    const workOrder = await workOrderService.assignComplaint(req.auth!, publicId, input<ManualAssignInput>(req, 'body'), req.id);
    sendCreated(res, { workOrder }, `/api/v1/work-orders/${workOrder.publicId}`);
  });

  // --- AI analysis (staff and admins) ---
  router.get('/:publicId/analysis', validate({ params }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { publicId } = input<Params>(req, 'params');
    sendSuccess(res, { analysis: await analysisService.summary(req.auth!, publicId, complaintService) });
  });

  router.post(
    '/:publicId/analysis',
    createRateLimiter({ ...rerunLimit, keyPart: (req) => req.auth?.userId }),
    validate({ params, body: rerunBody }),
    async (req, res) => {
      const { publicId } = input<Params>(req, 'params');
      const { types } = input<{ types: JobType[] }>(req, 'body');
      const jobs = await analysisService.rerun(req.auth!, publicId, types, complaintService);
      sendSuccess(res, { jobs }, { status: 202 });
    },
  );

  return router;
}
