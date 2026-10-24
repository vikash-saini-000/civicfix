import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { input, validate } from '../middleware/validate.js';
import type { DashboardService, DateRange } from '../services/dashboards.js';
import { sendSuccess } from '../utils/respond.js';
import { objectId } from '../validation/common.js';

export const MAX_RANGE_DAYS = 366;
const DAY = 86_400_000;
const PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 } as const;

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * Time range: `period` (7d, 30d, 90d, 365d) or `from`/`to` (ISO 8601, UTC). Default: the last 30 days.
 * `from` is inclusive, `to` exclusive; at most 366 days.
 */
const rangeQuery = z
  .strictObject({
    period: z.enum(Object.keys(PERIODS) as [keyof typeof PERIODS, ...(keyof typeof PERIODS)[]]).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    departmentId: objectId.optional(),
  })
  .refine((q) => !(q.period && (q.from || q.to)), { message: 'Use either period or from/to.', path: ['period'] })
  .transform((q, ctx) => {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - (q.period ? PERIODS[q.period] : 30) * DAY);
    if (from >= to) ctx.addIssue({ code: 'custom', message: 'from must be before to.', path: ['from'] });
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) ctx.addIssue({ code: 'custom', message: `The range can be at most ${MAX_RANGE_DAYS} days.`, path: ['from'] });
    return { range: { from, to } as DateRange, departmentId: q.departmentId };
  });

type Q = { range: DateRange; departmentId?: string };

/** /api/v1/dashboard/* */
export function dashboardsRouter(deps: { authService: AuthService; dashboardService: DashboardService }): Router {
  const router = Router();
  const svc = deps.dashboardService;
  router.use(requireAuth(deps.authService), (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });

  router.get('/citizen', validate({ query: rangeQuery }), async (req, res) => {
    sendSuccess(res, await svc.citizen(req.auth!, input<Q>(req, 'query').range));
  });
  router.get('/department', validate({ query: rangeQuery }), async (req, res) => {
    sendSuccess(res, await svc.member(req.auth!, input<Q>(req, 'query').departmentId));
  });
  router.get('/department/manager', validate({ query: rangeQuery }), async (req, res) => {
    const q = input<Q>(req, 'query');
    sendSuccess(res, await svc.manager(req.auth!, q.departmentId, q.range));
  });
  router.get('/admin', validate({ query: rangeQuery }), async (req, res) => {
    sendSuccess(res, await svc.admin(req.auth!, input<Q>(req, 'query').range));
  });
  return router;
}
