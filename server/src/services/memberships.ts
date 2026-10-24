import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { MembershipRole, MembershipStatus } from '../models/enums.js';
import { Department, DepartmentMembership, User } from '../models/index.js';
import { AppError, notFoundError } from '../utils/errors.js';
import { paginationMeta, toSkipLimit, type PaginationMeta, type PaginationQuery } from '../validation/pagination.js';
import { auditUserAction } from './audit.js';

/**
 * Who may do what, per department:
 *   platform admin            list, add (any role), change role, revoke (anyone)
 *   manager of THIS dept      list, add MEMBER, revoke MEMBER (not themselves)
 *   anyone else               nothing (403)
 * Authority is computed from req.auth (active memberships in active departments, reloaded per request),
 * never from request data, and always for the department in the URL.
 */
type Authority = 'ADMIN' | 'MANAGER';

export function authorityOver(principal: Principal, departmentId: string): Authority | null {
  if (principal.roles.has('PLATFORM_ADMIN')) return 'ADMIN';
  const manages = principal.memberships.some((m) => m.departmentId === departmentId && m.role === 'MANAGER');
  return manages ? 'MANAGER' : null;
}

const forbidden = (message = 'You do not have permission to manage members of this department.') => new AppError('FORBIDDEN', message);

function requireAuthority(principal: Principal, departmentId: string): Authority {
  const authority = authorityOver(principal, departmentId);
  if (!authority) throw forbidden();
  return authority;
}

export interface MembershipView {
  id: string;
  departmentId: string;
  user: { id: string; name: string; email: string };
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

type PopulatedMembership = {
  _id: unknown;
  department: unknown;
  user: { _id: unknown; name: string; email: string } | null;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt?: Date;
  updatedAt?: Date;
};

const toView = (m: PopulatedMembership): MembershipView => ({
  id: String(m._id),
  departmentId: String(m.department),
  user: m.user ? { id: String(m.user._id), name: m.user.name, email: m.user.email } : { id: '', name: '(deleted user)', email: '' },
  role: m.role,
  status: m.status,
  createdAt: (m.createdAt ?? new Date()).toISOString(),
  updatedAt: (m.updatedAt ?? new Date()).toISOString(),
});

async function viewById(id: Types.ObjectId | string): Promise<MembershipView> {
  const m = await DepartmentMembership.findById(id).populate('user', 'name email').lean();
  if (!m) throw notFoundError('The membership');
  return toView(m as unknown as PopulatedMembership);
}

export interface ListMembersQuery extends PaginationQuery {
  sort: Record<string, 1 | -1>;
  status: MembershipStatus | 'ALL';
  role?: MembershipRole;
}

export type MemberTarget = { userId: string } | { email: string };

export function createMembershipService() {
  async function loadActiveDepartment(departmentId: string) {
    const dept = await Department.findById(departmentId).select('isActive').lean();
    if (!dept) throw notFoundError('The department');
    if (!dept.isActive) throw new AppError('CONFLICT', 'This department is inactive. Reactivate it before changing its members.');
    return dept;
  }

  /** Loads a membership only within the given department, so a URL can't reach another department's records. */
  async function loadScoped(departmentId: string, membershipId: string) {
    const m = await DepartmentMembership.findOne({ _id: membershipId, department: departmentId });
    if (!m) throw notFoundError('The membership');
    return m;
  }

  return {
    async list(principal: Principal, departmentId: string, q: ListMembersQuery): Promise<{ items: MembershipView[]; pagination: PaginationMeta }> {
      requireAuthority(principal, departmentId);
      if (!(await Department.exists({ _id: departmentId }))) throw notFoundError('The department');
      const filter: Record<string, unknown> = { department: departmentId };
      if (q.status !== 'ALL') filter.status = q.status;
      if (q.role) filter.role = q.role;
      const { skip, limit } = toSkipLimit(q);
      const [docs, total] = await Promise.all([
        DepartmentMembership.find(filter).sort({ ...q.sort, _id: 1 }).skip(skip).limit(limit).populate('user', 'name email').lean(),
        DepartmentMembership.countDocuments(filter),
      ]);
      return { items: (docs as unknown as PopulatedMembership[]).map(toView), pagination: paginationMeta(q, total) };
    },

    /** Adds a user, or reactivates their revoked membership. Returns whether a new record was created. */
    async add(
      principal: Principal,
      departmentId: string,
      input: { target: MemberTarget; role: MembershipRole },
      requestId: string,
    ): Promise<{ membership: MembershipView; created: boolean }> {
      const authority = requireAuthority(principal, departmentId);
      if (authority === 'MANAGER' && input.role !== 'MEMBER') throw forbidden('Only platform administrators can appoint department managers.');
      await loadActiveDepartment(departmentId);

      const userFilter = 'userId' in input.target ? { _id: input.target.userId } : { email: input.target.email };
      const user = await User.findOne({ ...userFilter, accountStatus: 'ACTIVE' }).select('_id').lean();
      if (!user) throw notFoundError('An active account matching that user');

      // Reactivate a revoked membership atomically; otherwise insert. The unique index settles races.
      const reactivated = await DepartmentMembership.findOneAndUpdate(
        { user: user._id, department: departmentId, status: 'INACTIVE' },
        { $set: { status: 'ACTIVE', role: input.role } },
        { returnDocument: 'after', runValidators: true },
      );
      if (reactivated) {
        await auditUserAction({
          actor: principal,
          action: 'membership.reactivated',
          targetType: 'DepartmentMembership',
          targetId: reactivated._id,
          requestId,
          changes: [{ field: 'status', before: 'INACTIVE', after: 'ACTIVE' }, { field: 'role', after: input.role }],
        });
        return { membership: await viewById(reactivated._id), created: false };
      }

      let created;
      try {
        created = await DepartmentMembership.create({ user: user._id, department: departmentId, role: input.role, status: 'ACTIVE' });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'This user is already an active member of the department.');
        throw err;
      }
      await auditUserAction({
        actor: principal,
        action: 'membership.created',
        targetType: 'DepartmentMembership',
        targetId: created._id,
        requestId,
        changes: [{ field: 'role', after: input.role }, { field: 'user', after: String(user._id) }],
      });
      return { membership: await viewById(created._id), created: true };
    },

    /** Promote or demote. Platform admins only. */
    async changeRole(principal: Principal, departmentId: string, membershipId: string, role: MembershipRole, requestId: string): Promise<MembershipView> {
      if (requireAuthority(principal, departmentId) !== 'ADMIN') throw forbidden('Only platform administrators can change membership roles.');
      const m = await loadScoped(departmentId, membershipId);
      if (m.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This membership is revoked. Add the user again to reactivate it.');
      if (m.role !== role) {
        const before = m.role;
        const updated = await DepartmentMembership.findOneAndUpdate({ _id: m._id, status: 'ACTIVE', role: before }, { $set: { role } });
        if (!updated) throw new AppError('CONFLICT', 'The membership changed while you were editing it. Reload and try again.');
        await auditUserAction({
          actor: principal,
          action: 'membership.role_changed',
          targetType: 'DepartmentMembership',
          targetId: m._id,
          requestId,
          changes: [{ field: 'role', before, after: role }],
        });
      }
      return viewById(m._id);
    },

    /** Sets the membership INACTIVE (the record and its history stay). Idempotent. */
    async revoke(principal: Principal, departmentId: string, membershipId: string, requestId: string, reason?: string): Promise<MembershipView> {
      const authority = requireAuthority(principal, departmentId);
      const m = await loadScoped(departmentId, membershipId);
      if (authority === 'MANAGER') {
        if (String(m.user) === principal.userId) throw forbidden('You cannot revoke your own membership. Ask a platform administrator.');
        if (m.role !== 'MEMBER') throw forbidden('Only platform administrators can revoke a manager.');
      }
      const updated = await DepartmentMembership.findOneAndUpdate({ _id: m._id, status: 'ACTIVE' }, { $set: { status: 'INACTIVE' } });
      if (updated) {
        await auditUserAction({
          actor: principal,
          action: 'membership.revoked',
          targetType: 'DepartmentMembership',
          targetId: m._id,
          requestId,
          reason,
          changes: [{ field: 'status', before: 'ACTIVE', after: 'INACTIVE' }],
        });
      }
      return viewById(m._id);
    },
  };
}
export type MembershipService = ReturnType<typeof createMembershipService>;
