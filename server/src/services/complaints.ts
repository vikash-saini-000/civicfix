import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { Category, ComplaintStatus, Priority } from '../models/enums.js';
import { Complaint, Department, nextSequence } from '../models/index.js';
import { canTransition, transitionFor, type ComplaintAction } from '../policies/complaintLifecycle.js';
import { AppError, notFoundError, validationError } from '../utils/errors.js';
import { paginationMeta, toSkipLimit, type PaginationMeta, type PaginationQuery } from '../validation/pagination.js';
import { auditUserAction } from './audit.js';

// ---- access policy -----------------------------------------------------------
//
//   reporter            their own complaints (any status), full citizen view
//   department staff    complaints whose department is one where they have an ACTIVE membership
//                       (in an active department); read-only in this phase
//   department manager  as staff, plus reject while the complaint is still in triage
//   platform admin      everything, incl. complaints with no department yet; classify and reject
//   anyone else         nothing; inaccessible complaints are reported as 404
//
// Memberships come from req.auth (reloaded per request), so revocation applies immediately.

const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');
const departmentIdsOf = (p: Principal) => p.memberships.map((m) => m.departmentId);
const managesDepartment = (p: Principal, departmentId: string | null) =>
  !!departmentId && p.memberships.some((m) => m.departmentId === departmentId && m.role === 'MANAGER');

export type Relation = 'admin' | 'reporter' | 'staff';

export function relationTo(p: Principal, c: { citizen: unknown; department?: unknown }): Relation | null {
  if (isAdmin(p)) return 'admin';
  if (String(c.citizen) === p.userId) return 'reporter';
  if (c.department && departmentIdsOf(p).includes(String(c.department))) return 'staff';
  return null;
}

// ---- views -----------------------------------------------------------------------

export interface ComplaintView {
  id: string;
  publicId: string;
  title: string;
  description: string;
  location: { lat: number; lng: number };
  landmark: string | null;
  selectedCategory: Category | null;
  confirmedCategory: Category | null;
  department: { id: string; name: string } | null;
  priority: Priority | null;
  status: ComplaintStatus;
  statusHistory: { status: ComplaintStatus; at: string; note: string | null }[];
  rejectionReason: string | null;
  /** Present for staff and admins only. Contact details are never included. */
  reporter?: { id: string; name: string };
  /** Actions the caller may perform now; a UI hint only. The server re-checks every action. */
  allowedActions: ComplaintAction[];
  createdAt: string;
  updatedAt: string;
}

type ComplaintDoc = {
  _id: Types.ObjectId;
  publicId: string;
  citizen: Types.ObjectId | { _id: Types.ObjectId; name: string };
  title: string;
  description: string;
  location: { coordinates: number[] };
  landmark?: string | null;
  selectedCategory?: Category | null;
  confirmedCategory?: Category | null;
  department?: Types.ObjectId | { _id: Types.ObjectId; name: string } | null;
  priority?: Priority | null;
  status: ComplaintStatus;
  statusHistory: { status: ComplaintStatus; at: Date; publicNote?: string | null }[];
  rejectionReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const refId = (v: unknown) => (v && typeof v === 'object' && '_id' in v ? String((v as { _id: unknown })._id) : v ? String(v) : null);

function allowedActions(p: Principal, c: ComplaintDoc): ComplaintAction[] {
  const actions: ComplaintAction[] = [];
  if (isAdmin(p) && canTransition('classify', c.status)) actions.push('classify');
  if ((isAdmin(p) || managesDepartment(p, refId(c.department))) && canTransition('reject', c.status)) actions.push('reject');
  return actions;
}

function toView(p: Principal, c: ComplaintDoc, relation: Relation): ComplaintView {
  const dept = c.department && typeof c.department === 'object' && 'name' in c.department ? c.department : null;
  const view: ComplaintView = {
    id: String(c._id),
    publicId: c.publicId,
    title: c.title,
    description: c.description,
    location: { lat: c.location.coordinates[1]!, lng: c.location.coordinates[0]! },
    landmark: c.landmark ?? null,
    selectedCategory: c.selectedCategory ?? null,
    confirmedCategory: c.confirmedCategory ?? null,
    department: dept ? { id: String(dept._id), name: dept.name } : null,
    priority: c.priority ?? null,
    status: c.status,
    statusHistory: c.statusHistory.map((h) => ({ status: h.status, at: h.at.toISOString(), note: h.publicNote ?? null })),
    rejectionReason: c.rejectionReason ?? null,
    allowedActions: allowedActions(p, c),
    createdAt: (c.createdAt ?? new Date()).toISOString(),
    updatedAt: (c.updatedAt ?? new Date()).toISOString(),
  };
  if (relation !== 'reporter' && typeof c.citizen === 'object' && 'name' in c.citizen) {
    view.reporter = { id: String(c.citizen._id), name: c.citizen.name };
  }
  return view;
}

const POPULATE = [
  { path: 'department', select: 'name' },
  { path: 'citizen', select: 'name' },
] as const;

// ---- inputs -----------------------------------------------------------------------

export interface CreateComplaintInput {
  title: string;
  description: string;
  location: { lat: number; lng: number };
  landmark?: string;
  selectedCategory?: Category | null;
}

export type ListScope = 'mine' | 'department' | 'all';

export interface ListComplaintsQuery extends PaginationQuery {
  scope: ListScope;
  sort: Record<string, 1 | -1>;
  status?: ComplaintStatus[];
  category?: Category;
  priority?: Priority;
  departmentId?: string;
  unassigned?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface ClassifyInput {
  departmentId: string;
  category: Category;
  priority?: Priority;
  note?: string;
}

const notFound = () => notFoundError('The complaint');

export interface ComplaintServiceHooks {
  /** Called after a complaint is stored (e.g. to queue AI analysis). Errors are logged, never surfaced. */
  onCreated?: (complaintId: Types.ObjectId) => Promise<unknown>;
  onHookError?: (err: unknown) => void;
}

export function createComplaintService(hooks: ComplaintServiceHooks = {}) {
  /** Loads a complaint and the caller's relation to it, or 404 if it doesn't exist or isn't visible. */
  async function loadVisible(p: Principal, publicId: string) {
    const c = (await Complaint.findOne({ publicId }).populate([...POPULATE]).lean()) as ComplaintDoc | null;
    if (!c) throw notFound();
    const relation = relationTo(p, { citizen: refId(c.citizen), department: refId(c.department) });
    if (!relation) throw notFound();
    return { c, relation };
  }

  async function reload(p: Principal, id: Types.ObjectId, relation: Relation) {
    const c = (await Complaint.findById(id).populate([...POPULATE]).lean()) as ComplaintDoc;
    return toView(p, c, relation);
  }

  /**
   * Moves the complaint only if it is still in an allowed status (atomic), so two concurrent
   * actions can't both succeed from the same state.
   */
  async function applyTransition(
    c: ComplaintDoc,
    action: ComplaintAction,
    set: Record<string, unknown>,
    publicNote: string | undefined,
  ): Promise<void> {
    const { from, to } = transitionFor(action);
    const now = new Date();
    const updated = await Complaint.findOneAndUpdate(
      { _id: c._id, status: { $in: from } },
      { $set: { ...set, status: to }, $push: { statusHistory: { status: to, at: now, publicNote } } },
      { runValidators: true },
    );
    if (!updated) throw new AppError('CONFLICT', 'The complaint changed or is no longer in a state that allows this action.');
  }

  return {
    async create(p: Principal, input: CreateComplaintInput, requestId: string): Promise<ComplaintView> {
      const year = new Date().getUTCFullYear();
      const seq = await nextSequence(`complaint-${year}`);
      const now = new Date();
      const complaint = await Complaint.create({
        publicId: `CF-${year}-${String(seq).padStart(5, '0')}`,
        citizen: p.userId, // always the authenticated user
        title: input.title,
        description: input.description,
        location: { type: 'Point', coordinates: [input.location.lng, input.location.lat] },
        landmark: input.landmark,
        selectedCategory: input.selectedCategory ?? undefined,
        status: 'REPORTED',
        statusHistory: [{ status: 'REPORTED', at: now }],
      });
      await auditUserAction({
        actor: p,
        action: 'complaint.created',
        targetType: 'Complaint',
        targetId: complaint._id,
        requestId,
        changes: [{ field: 'publicId', after: complaint.publicId }],
      });
      // Analysis must never block or fail submission.
      if (hooks.onCreated) await hooks.onCreated(complaint._id).catch((err) => hooks.onHookError?.(err));
      return reload(p, complaint._id, 'reporter');
    },

    async list(p: Principal, q: ListComplaintsQuery): Promise<{ items: ComplaintView[]; pagination: PaginationMeta }> {
      // 1. Access scope, decided from the principal alone.
      let scope: Record<string, unknown>;
      if (q.scope === 'mine') {
        scope = { citizen: new Types.ObjectId(p.userId) };
      } else if (q.scope === 'department') {
        const allowed = departmentIdsOf(p);
        if (q.departmentId && !allowed.includes(q.departmentId) && !isAdmin(p)) {
          throw new AppError('FORBIDDEN', 'You are not a member of that department.');
        }
        const ids = q.departmentId ? [q.departmentId] : allowed;
        if (ids.length === 0) throw new AppError('FORBIDDEN', 'You are not an active member of any department.');
        scope = { department: { $in: ids.map((id) => new Types.ObjectId(id)) } };
      } else {
        if (!isAdmin(p)) throw new AppError('FORBIDDEN', 'Only platform administrators can list all complaints.');
        scope = {};
      }
      if (q.unassigned && !isAdmin(p)) throw new AppError('FORBIDDEN', 'Only platform administrators can list unassigned complaints.');

      // 2. Filters, always combined with the scope (never replacing it).
      const filters: Record<string, unknown>[] = [scope];
      if (q.status?.length) filters.push({ status: { $in: q.status } });
      if (q.priority) filters.push({ priority: q.priority });
      if (q.category) filters.push({ $or: [{ confirmedCategory: q.category }, { confirmedCategory: null, selectedCategory: q.category }] });
      if (q.departmentId && q.scope !== 'department') filters.push({ department: new Types.ObjectId(q.departmentId) });
      if (q.unassigned) filters.push({ department: null });
      if (q.createdFrom || q.createdTo) {
        filters.push({ createdAt: { ...(q.createdFrom && { $gte: q.createdFrom }), ...(q.createdTo && { $lt: q.createdTo }) } });
      }
      const filter = { $and: filters };

      const { skip, limit } = toSkipLimit(q);
      const [docs, total] = await Promise.all([
        Complaint.find(filter).sort({ ...q.sort, _id: -1 }).skip(skip).limit(limit).populate([...POPULATE]).lean(),
        Complaint.countDocuments(filter),
      ]);
      const items = (docs as unknown as ComplaintDoc[]).map((c) => toView(p, c, relationTo(p, { citizen: refId(c.citizen), department: refId(c.department) }) ?? 'reporter'));
      return { items, pagination: paginationMeta(q, total) };
    },

    /** For other features (e.g. analysis): the complaint and the caller's relation, or 404. */
    async access(p: Principal, publicId: string) {
      const { c, relation } = await loadVisible(p, publicId);
      return { complaintId: c._id, departmentId: refId(c.department), relation, title: c.title, description: c.description };
    },

    async get(p: Principal, publicId: string): Promise<ComplaintView> {
      const { c, relation } = await loadVisible(p, publicId);
      return toView(p, c, relation);
    },

    /** Manual triage (platform admin): confirm category, route to a department, optionally set priority. */
    async classify(p: Principal, publicId: string, input: ClassifyInput, requestId: string): Promise<ComplaintView> {
      const { c, relation } = await loadVisible(p, publicId);
      if (!isAdmin(p)) throw new AppError('FORBIDDEN', 'Only platform administrators can classify complaints.');
      if (!canTransition('classify', c.status)) throw new AppError('CONFLICT', `A complaint that is ${c.status} can't be classified.`);

      const dept = await Department.findById(input.departmentId).select('name categories isActive').lean();
      if (!dept || !dept.isActive) {
        throw validationError([{ field: 'body.departmentId', issue: 'invalid', message: 'No active department with this ID.' }]);
      }
      if (!dept.categories.includes(input.category)) {
        throw validationError([{ field: 'body.departmentId', issue: 'invalid', message: `This department does not handle "${input.category}".` }]);
      }

      const before = { department: refId(c.department), confirmedCategory: c.confirmedCategory ?? null, priority: c.priority ?? null, status: c.status };
      const set: Record<string, unknown> = { department: dept._id, confirmedCategory: input.category };
      if (input.priority) set.priority = input.priority;
      await applyTransition(c, 'classify', set, input.note ?? `Sent to ${dept.name} for review.`);
      await auditUserAction({
        actor: p,
        action: 'complaint.classified',
        targetType: 'Complaint',
        targetId: c._id,
        requestId,
        changes: [
          { field: 'department', before: before.department, after: String(dept._id) },
          { field: 'confirmedCategory', before: before.confirmedCategory, after: input.category },
          ...(input.priority ? [{ field: 'priority', before: before.priority, after: input.priority }] : []),
          { field: 'status', before: before.status, after: 'UNDER_REVIEW' },
        ],
      });
      return reload(p, c._id, relation);
    },

    /** Rejects during triage (platform admin, or manager of the complaint's department). Reason is shown to the citizen. */
    async reject(p: Principal, publicId: string, reason: string, requestId: string): Promise<ComplaintView> {
      const { c, relation } = await loadVisible(p, publicId);
      if (!isAdmin(p) && !managesDepartment(p, refId(c.department))) {
        throw new AppError('FORBIDDEN', 'Only platform administrators or this department’s managers can reject this complaint.');
      }
      if (!canTransition('reject', c.status)) throw new AppError('CONFLICT', `A complaint that is ${c.status} can't be rejected.`);
      await applyTransition(c, 'reject', { rejectionReason: reason }, reason);
      await auditUserAction({
        actor: p,
        action: 'complaint.rejected',
        targetType: 'Complaint',
        targetId: c._id,
        requestId,
        reason,
        changes: [{ field: 'status', before: c.status, after: 'REJECTED' }],
      });
      return reload(p, c._id, relation);
    },
  };
}
export type ComplaintService = ReturnType<typeof createComplaintService>;
