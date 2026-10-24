import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter, type RateLimitOptions } from '../middleware/rateLimit.js';
import { input, validate } from '../middleware/validate.js';
import { CATEGORIES, COMPLAINT_STATUSES, PRIORITIES } from '../models/enums.js';
import type { ClassifyInput, ComplaintService, CreateComplaintInput, ListComplaintsQuery } from '../services/complaints.js';
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

export interface ComplaintsRouterDeps {
  authService: AuthService;
  complaintService: ComplaintService;
  /** Per-user limit on new complaints. */
  createLimit?: RateLimitOptions;
}

export const DEFAULT_CREATE_LIMIT: RateLimitOptions = { windowMs: 60 * 60_000, limit: 20 };

/** /api/v1/complaints */
export function complaintsRouter({ authService, complaintService, createLimit = DEFAULT_CREATE_LIMIT }: ComplaintsRouterDeps): Router {
  const router = Router();
  router.use(requireAuth(authService));
  type Params = z.infer<typeof params>;

  router.post(
    '/',
    createRateLimiter({ ...createLimit, keyPart: (req) => req.auth?.userId }),
    validate({ body: createBody }),
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

  return router;
}
