import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { input, validate } from '../middleware/validate.js';
import { PRIORITIES, WORK_ORDER_STATUSES } from '../models/enums.js';
import type { ListWorkOrdersQuery, WorkOrderService } from '../services/workOrders.js';
import { sendSuccess } from '../utils/respond.js';
import { objectId, text } from '../validation/common.js';
import { paginationQuery, sortQuery } from '../validation/pagination.js';

/** Work-order IDs: public ID (WO-2026-00001, case-insensitive) or the 24-hex database ID. */
const workOrderId = z
  .string()
  .trim()
  .regex(/^(WO-\d{4}-\d{5,}|[0-9a-fA-F]{24})$/i, 'Must be a work-order ID like WO-2026-00001.');
const params = z.strictObject({ id: workOrderId });
type Params = z.infer<typeof params>;

const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(500)
    .transform((s) => s.split(','))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

const listQuery = paginationQuery.extend({
  scope: z.enum(['mine', 'department', 'all']).default('mine'),
  sort: sortQuery(['createdAt', 'updatedAt', 'dueAt', 'priority'], 'dueAt'),
  status: csvEnum(WORK_ORDER_STATUSES).optional(),
  departmentId: objectId.optional(),
  priority: z.enum(PRIORITIES).optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const empty = z.strictObject({});
const reason = text(3, 1000);
const assignBody = z.strictObject({ assigneeId: objectId, reason: text(3, 1000).optional() });
const reasonBody = z.strictObject({ reason });
const blockBody = z.strictObject({ reason, nextAction: text(3, 1000) });
const noteBody = z.strictObject({ text: text(1, 2000) });
const transferBody = z.strictObject({ departmentId: objectId, reason });

/** /api/v1/work-orders. Department staff and admins only; citizens never see work orders. */
export function workOrdersRouter(deps: { authService: AuthService; workOrderService: WorkOrderService }): Router {
  const router = Router();
  const svc = deps.workOrderService;
  router.use(requireAuth(deps.authService));

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    const { items, pagination } = await svc.list(req.auth!, input<ListWorkOrdersQuery>(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });

  router.get('/:id', validate({ params }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.get(req.auth!, input<Params>(req, 'params').id) });
  });

  const id = (req: Parameters<Parameters<typeof router.post>[1]>[0]) => input<Params>(req, 'params').id;

  router.post('/:id/assign', validate({ params, body: assignBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.assignStaff(req.auth!, id(req), input<z.infer<typeof assignBody>>(req, 'body'), req.id) });
  });
  router.post('/:id/decline', validate({ params, body: reasonBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.decline(req.auth!, id(req), input<{ reason: string }>(req, 'body').reason, req.id) });
  });
  router.post('/:id/accept', validate({ params, body: empty }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.accept(req.auth!, id(req), req.id) });
  });
  router.post('/:id/start', validate({ params, body: empty }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.start(req.auth!, id(req), req.id) });
  });
  router.post('/:id/block', validate({ params, body: blockBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.block(req.auth!, id(req), input<z.infer<typeof blockBody>>(req, 'body'), req.id) });
  });
  router.post('/:id/notes', validate({ params, body: noteBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.addNote(req.auth!, id(req), input<{ text: string }>(req, 'body').text, req.id) });
  });
  router.post('/:id/transfer', validate({ params, body: transferBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.transfer(req.auth!, id(req), input<z.infer<typeof transferBody>>(req, 'body'), req.id) });
  });
  router.post('/:id/cancel', validate({ params, body: reasonBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await svc.cancel(req.auth!, id(req), input<{ reason: string }>(req, 'body').reason, req.id) });
  });

  return router;
}

/** /api/v1/assignments: complaints waiting for a routing decision. */
export function assignmentsRouter(deps: { authService: AuthService; workOrderService: WorkOrderService }): Router {
  const router = Router();
  router.use(requireAuth(deps.authService));
  router.get('/queue', validate({ query: paginationQuery }), async (req, res) => {
    const { items, pagination } = await deps.workOrderService.reviewQueue(req.auth!, input(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });
  return router;
}
