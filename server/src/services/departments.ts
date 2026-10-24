import type { Principal } from '../auth/roles.js';
import type { Category, WorkOrderStatus } from '../models/enums.js';
import { Department, WorkOrder } from '../models/index.js';
import { AppError, notFoundError } from '../utils/errors.js';
import { paginationMeta, toSkipLimit, type PaginationMeta, type PaginationQuery } from '../validation/pagination.js';
import { auditUserAction, diff } from './audit.js';

export interface DepartmentView {
  id: string;
  name: string;
  description: string | null;
  categories: Category[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type DepartmentDoc = {
  _id: unknown;
  name: string;
  description?: string | null;
  categories: Category[];
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

export const toDepartmentView = (d: DepartmentDoc): DepartmentView => ({
  id: String(d._id),
  name: d.name,
  description: d.description ?? null,
  categories: [...d.categories],
  isActive: d.isActive,
  createdAt: (d.createdAt ?? new Date()).toISOString(),
  updatedAt: (d.updatedAt ?? new Date()).toISOString(),
});

export interface DepartmentInput {
  name: string;
  description?: string;
  categories: Category[];
}

export interface ListDepartmentsQuery extends PaginationQuery {
  sort: Record<string, 1 | -1>;
  category?: Category;
  includeInactive: boolean;
}

/** Work-order statuses that count as open work for the deactivation check. */
const CLOSED_WORK: WorkOrderStatus[] = ['COMPLETED', 'CANCELLED'];

const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');
const nameTaken = () =>
  new AppError('CONFLICT', 'A department with this name already exists.', [
    { field: 'body.name', issue: 'duplicate', message: 'This name is already used.' },
  ]);

async function saveOrConflict<T extends { save(): Promise<unknown> }>(doc: T): Promise<void> {
  try {
    await doc.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw nameTaken();
    throw err;
  }
}

/** Departments: anyone signed in reads active ones; only platform admins create, change, or (de)activate. */
export function createDepartmentService() {
  async function loadForAdmin(id: string) {
    const dept = await Department.findById(id);
    if (!dept) throw notFoundError('The department');
    return dept;
  }

  return {
    async list(principal: Principal, q: ListDepartmentsQuery): Promise<{ items: DepartmentView[]; pagination: PaginationMeta }> {
      if (q.includeInactive && !isAdmin(principal)) {
        throw new AppError('FORBIDDEN', 'Only platform administrators can list inactive departments.');
      }
      const filter: Record<string, unknown> = {};
      if (!q.includeInactive) filter.isActive = true;
      if (q.category) filter.categories = q.category;
      const { skip, limit } = toSkipLimit(q);
      const [docs, total] = await Promise.all([
        Department.find(filter).sort({ ...q.sort, _id: 1 }).collation({ locale: 'en', strength: 2 }).skip(skip).limit(limit).lean(),
        Department.countDocuments(filter),
      ]);
      return { items: docs.map(toDepartmentView), pagination: paginationMeta(q, total) };
    },

    /** Inactive departments are visible only to platform admins; others get 404. */
    async get(principal: Principal, id: string): Promise<DepartmentView> {
      const dept = await Department.findById(id).lean();
      if (!dept || (!dept.isActive && !isAdmin(principal))) throw notFoundError('The department');
      return toDepartmentView(dept);
    },

    async create(principal: Principal, input: DepartmentInput, requestId: string): Promise<DepartmentView> {
      const dept = new Department({ ...input, isActive: true });
      await saveOrConflict(dept);
      await auditUserAction({
        actor: principal,
        action: 'department.created',
        targetType: 'Department',
        targetId: dept._id,
        requestId,
        changes: [{ field: 'name', after: dept.name }, { field: 'categories', after: [...dept.categories] }],
      });
      return toDepartmentView(dept);
    },

    async update(principal: Principal, id: string, input: Partial<DepartmentInput>, requestId: string): Promise<DepartmentView> {
      const dept = await loadForAdmin(id);
      const snapshot = () => ({ name: dept.name, description: dept.description ?? null, categories: [...dept.categories] });
      const before = snapshot();
      if (input.name !== undefined) dept.name = input.name;
      if (input.description !== undefined) dept.description = input.description;
      if (input.categories !== undefined) dept.set('categories', input.categories);
      const changes = diff(before, snapshot(), ['name', 'description', 'categories']);
      if (changes.length > 0) {
        await saveOrConflict(dept);
        await auditUserAction({ actor: principal, action: 'department.updated', targetType: 'Department', targetId: dept._id, requestId, changes });
      }
      return toDepartmentView(dept);
    },

    /**
     * Deactivation keeps the record, its memberships and history; memberships simply stop granting
     * access. Refused while the department has open work orders, which must be moved or closed first.
     */
    async setActive(principal: Principal, id: string, active: boolean, requestId: string, reason?: string): Promise<DepartmentView> {
      const dept = await loadForAdmin(id);
      if (dept.isActive === active) return toDepartmentView(dept);
      if (!active && (await WorkOrder.exists({ department: dept._id, status: { $nin: CLOSED_WORK } }))) {
        throw new AppError('CONFLICT', 'This department still has open work orders. Reassign or close them before deactivating it.');
      }
      dept.isActive = active;
      await dept.save();
      await auditUserAction({
        actor: principal,
        action: active ? 'department.reactivated' : 'department.deactivated',
        targetType: 'Department',
        targetId: dept._id,
        requestId,
        reason,
        changes: [{ field: 'isActive', before: !active, after: active }],
      });
      return toDepartmentView(dept);
    },
  };
}
export type DepartmentService = ReturnType<typeof createDepartmentService>;
