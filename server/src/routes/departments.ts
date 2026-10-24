import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { input, validate } from '../middleware/validate.js';
import { CATEGORIES, MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from '../models/enums.js';
import type { DepartmentInput, DepartmentService, ListDepartmentsQuery } from '../services/departments.js';
import type { ListMembersQuery, MemberTarget, MembershipService } from '../services/memberships.js';
import { sendCreated, sendSuccess } from '../utils/respond.js';
import { objectId, text } from '../validation/common.js';
import { paginationQuery, sortQuery } from '../validation/pagination.js';

const categories = z
  .array(z.enum(CATEGORIES))
  .min(1)
  .max(CATEGORIES.length)
  .refine((c) => new Set(c).size === c.length, 'Categories must not repeat.');

const departmentBody = z.strictObject({
  name: text(2, 100),
  description: text(0, 1000).optional(),
  categories,
});
const departmentPatch = departmentBody.partial().refine((b) => Object.keys(b).length > 0, 'Send at least one field to update.');
const reasonBody = z.strictObject({ reason: text(1, 500).optional() });

const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const listDepartments = paginationQuery.extend({
  sort: sortQuery(['name', 'createdAt'], 'name'),
  category: z.enum(CATEGORIES).optional(),
  includeInactive: booleanQuery.default(false),
});

const deptParams = z.strictObject({ departmentId: objectId });
const memberParams = z.strictObject({ departmentId: objectId, membershipId: objectId });

const email = z.string().trim().toLowerCase().pipe(z.email('Must be a valid email address.').max(254));
// Identify the user by ID or by email, not both.
const addMemberBody = z
  .strictObject({ userId: objectId.optional(), email: email.optional(), role: z.enum(MEMBERSHIP_ROLES).default('MEMBER') })
  .refine((b) => (b.userId === undefined) !== (b.email === undefined), {
    message: 'Send exactly one of userId or email.',
    path: ['userId'],
  });
const changeRoleBody = z.strictObject({ role: z.enum(MEMBERSHIP_ROLES) });
const listMembers = paginationQuery.extend({
  sort: sortQuery(['createdAt', 'role'], 'createdAt'),
  status: z.enum([...MEMBERSHIP_STATUSES, 'ALL']).default('ACTIVE'),
  role: z.enum(MEMBERSHIP_ROLES).optional(),
});

type DeptParams = z.infer<typeof deptParams>;
type MemberParams = z.infer<typeof memberParams>;

export interface DepartmentsRouterDeps {
  authService: AuthService;
  departmentService: DepartmentService;
  membershipService: MembershipService;
}

/** /api/v1/departments, including /:departmentId/members. */
export function departmentsRouter({ authService, departmentService, membershipService }: DepartmentsRouterDeps): Router {
  const router = Router();
  const adminOnly = requireRole('PLATFORM_ADMIN');
  router.use(requireAuth(authService));

  // --- Departments ---
  router.get('/', validate({ query: listDepartments }), async (req, res) => {
    const { items, pagination } = await departmentService.list(req.auth!, input<ListDepartmentsQuery>(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });

  router.post('/', adminOnly, validate({ body: departmentBody }), async (req, res) => {
    const dept = await departmentService.create(req.auth!, input<DepartmentInput>(req, 'body'), req.id);
    sendCreated(res, { department: dept }, `/api/v1/departments/${dept.id}`);
  });

  router.get('/:departmentId', validate({ params: deptParams }), async (req, res) => {
    sendSuccess(res, { department: await departmentService.get(req.auth!, input<DeptParams>(req, 'params').departmentId) });
  });

  router.patch('/:departmentId', adminOnly, validate({ params: deptParams, body: departmentPatch }), async (req, res) => {
    const { departmentId } = input<DeptParams>(req, 'params');
    sendSuccess(res, { department: await departmentService.update(req.auth!, departmentId, input<Partial<DepartmentInput>>(req, 'body'), req.id) });
  });

  for (const [action, active] of [['deactivate', false], ['reactivate', true]] as const) {
    router.post(`/:departmentId/${action}`, adminOnly, validate({ params: deptParams, body: reasonBody }), async (req, res) => {
      const { departmentId } = input<DeptParams>(req, 'params');
      const { reason } = input<{ reason?: string }>(req, 'body');
      sendSuccess(res, { department: await departmentService.setActive(req.auth!, departmentId, active, req.id, reason) });
    });
  }

  // --- Memberships (authority is checked per department inside the service) ---
  router.get('/:departmentId/members', validate({ params: deptParams, query: listMembers }), async (req, res) => {
    const { departmentId } = input<DeptParams>(req, 'params');
    const { items, pagination } = await membershipService.list(req.auth!, departmentId, input<ListMembersQuery>(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });

  router.post('/:departmentId/members', validate({ params: deptParams, body: addMemberBody }), async (req, res) => {
    const { departmentId } = input<DeptParams>(req, 'params');
    const body = input<z.infer<typeof addMemberBody>>(req, 'body');
    const target: MemberTarget = body.userId ? { userId: body.userId } : { email: body.email! };
    const { membership, created } = await membershipService.add(req.auth!, departmentId, { target, role: body.role }, req.id);
    if (created) sendCreated(res, { membership }, `/api/v1/departments/${departmentId}/members/${membership.id}`);
    else sendSuccess(res, { membership });
  });

  router.patch('/:departmentId/members/:membershipId', validate({ params: memberParams, body: changeRoleBody }), async (req, res) => {
    const { departmentId, membershipId } = input<MemberParams>(req, 'params');
    const { role } = input<z.infer<typeof changeRoleBody>>(req, 'body');
    sendSuccess(res, { membership: await membershipService.changeRole(req.auth!, departmentId, membershipId, role, req.id) });
  });

  // Revokes (status INACTIVE); the record is kept. An optional JSON body may carry { "reason": "..." }.
  router.delete('/:departmentId/members/:membershipId', validate({ params: memberParams, body: reasonBody }), async (req, res) => {
    const { departmentId, membershipId } = input<MemberParams>(req, 'params');
    const { reason } = input<{ reason?: string }>(req, 'body');
    sendSuccess(res, { membership: await membershipService.revoke(req.auth!, departmentId, membershipId, req.id, reason) });
  });

  return router;
}
