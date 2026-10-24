import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { input, validate } from '../middleware/validate.js';
import { ACTOR_TYPES, AUDIT_OUTCOMES, RESOURCE_TYPES } from '../models/enums.js';
import { AuditLog } from '../models/index.js';
import type { NotificationService } from '../services/notifications.js';
import { notFoundError } from '../utils/errors.js';
import { sendSuccess } from '../utils/respond.js';
import { idParams, objectId } from '../validation/common.js';
import { paginationMeta, paginationQuery, toSkipLimit, type PaginationQuery } from '../validation/pagination.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const listNotifications = paginationQuery.extend({ unread: bool.optional() });
const empty = z.strictObject({});

/** /api/v1/notifications: always the signed-in user's own notifications. */
export function notificationsRouter(deps: { authService: AuthService; notificationService: NotificationService }): Router {
  const router = Router();
  const svc = deps.notificationService;
  router.use(requireAuth(deps.authService));

  router.get('/', validate({ query: listNotifications }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { items, pagination } = await svc.list(req.auth!, input(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });
  router.get('/unread-count', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { count: await svc.unreadCount(req.auth!) });
  });
  router.post('/read-all', validate({ body: empty }), async (req, res) => {
    sendSuccess(res, await svc.markAllRead(req.auth!));
  });
  router.post('/:id/read', validate({ params: idParams, body: empty }), async (req, res) => {
    sendSuccess(res, await svc.markRead(req.auth!, input<{ id: string }>(req, 'params').id));
  });
  return router;
}

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const auditQuery = paginationQuery
  .extend({
    // Exact action ("dispute.decided") or a prefix ending in a dot ("work_order.").
    action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]*)*$/, 'Must be an action like work_order.accept or a prefix like work_order.').max(100).optional(),
    targetType: z.enum(RESOURCE_TYPES).optional(),
    targetId: objectId.optional(),
    actorId: objectId.optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    outcome: z.enum(AUDIT_OUTCOMES).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => !(q.from && q.to && q.from >= q.to), { message: 'from must be before to.', path: ['from'] });

type AuditQuery = PaginationQuery & {
  action?: string;
  targetType?: string;
  targetId?: string;
  actorId?: string;
  actorType?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
};

const auditView = (a: Record<string, any>) => ({
  id: String(a._id),
  actorType: a.actorType,
  actorId: a.actor ? String(a.actor) : null,
  action: a.action,
  targetType: a.targetType,
  targetId: String(a.targetId),
  outcome: a.outcome,
  reason: a.reason ?? null,
  correlationId: a.correlationId ?? null,
  changes: a.changes ?? [],
  createdAt: a.createdAt.toISOString(),
});

/** /api/v1/audit-logs: read-only, platform administrators only. There is no write endpoint. */
export function auditLogsRouter(deps: { authService: AuthService }): Router {
  const router = Router();
  router.use(requireAuth(deps.authService), requireRole('PLATFORM_ADMIN'));

  router.get('/', validate({ query: auditQuery }), async (req, res) => {
    const q = input<AuditQuery>(req, 'query');
    const filter: Record<string, unknown> = {};
    if (q.action) filter.action = q.action.endsWith('.') ? { $regex: `^${q.action.replace(/\./g, '\\.')}` } : q.action;
    if (q.targetType) filter.targetType = q.targetType;
    if (q.targetId) filter.targetId = new Types.ObjectId(q.targetId);
    if (q.actorId) filter.actor = new Types.ObjectId(q.actorId);
    if (q.actorType) filter.actorType = q.actorType;
    if (q.outcome) filter.outcome = q.outcome;
    if (q.from || q.to) filter.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lt: q.to }) };
    const { skip, limit } = toSkipLimit(q);
    const [docs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    sendSuccess(res, docs.map(auditView), { meta: { pagination: paginationMeta(q, total) } });
  });

  router.get('/:id', validate({ params: idParams }), async (req, res) => {
    const a = await AuditLog.findById(input<{ id: string }>(req, 'params').id).lean();
    if (!a) throw notFoundError('The audit record');
    sendSuccess(res, { auditLog: auditView(a) });
  });
  return router;
}
