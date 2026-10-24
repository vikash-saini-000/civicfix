import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { Category, ComplaintStatus, Priority } from '../models/enums.js';
import { AuditLog, Complaint, Department, WorkOrder, nextSequence } from '../models/index.js';
import { resolveWard } from './location.js';
import { checkSpam } from './spam.js';
import { canTransition, transitionFor, type ComplaintAction } from '../policies/complaintLifecycle.js';
import { AppError, notFoundError, validationError } from '../utils/errors.js';
import { paginationMeta, toSkipLimit, type PaginationMeta, type PaginationQuery } from '../validation/pagination.js';
import { auditUserAction } from './audit.js';
import type { EventBus } from '../events/bus.js';

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
//
// Reporter identity: department staff see only a stable pseudonym ("Reporter #3fa2c1"), never the
// reporter's name, account ID or contact details. Platform admins see the name and account ID.

const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');
const departmentIdsOf = (p: Principal) => p.memberships.map((m) => m.departmentId);
const managesDepartment = (p: Principal, departmentId: string | null) =>
  !!departmentId && p.memberships.some((m) => m.departmentId === departmentId && m.role === 'MANAGER');

export type Relation = 'admin' | 'reporter' | 'staff';

export function relationTo(p: Principal, c: { citizen: unknown; department?: unknown; routingReview?: { suggestedDepartment?: unknown } | null }): Relation | null {
  if (isAdmin(p)) return 'admin';
  if (String(c.citizen) === p.userId) return 'reporter';
  if (c.department && departmentIdsOf(p).includes(String(c.department))) return 'staff';
  // Unrouted case the AI suggested for a department: that department's managers decide, so they can see it.
  const suggested = !c.department && c.routingReview?.suggestedDepartment ? refId(c.routingReview.suggestedDepartment) : null;
  if (suggested && managesDepartment(p, suggested)) return 'staff';
  return null;
}

// ---- views -----------------------------------------------------------------------

export type ComplaintViewAction = ComplaintAction | 'answer_follow_up' | 'link_duplicate' | 'unlink_duplicate';

export interface ComplaintView {
  id: string;
  publicId: string;
  title: string;
  description: string;
  location: { lat: number; lng: number };
  landmark: string | null;
  /** Street address looked up by the server; null if unknown. */
  address: string | null;
  ward: { id: string; code: string; name: string } | null;
  selectedCategory: Category | null;
  confirmedCategory: Category | null;
  department: { id: string; name: string } | null;
  priority: Priority | null;
  status: ComplaintStatus;
  statusHistory: { status: ComplaintStatus; at: string; note: string | null }[];
  rejectionReason: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Questions the AI asked the reporter, and their answers (reporter and staff). */
  followUp: { questions: string[]; answers: string[]; askedAt: string; answeredAt: string | null } | null;
  /** Set when this report was linked to another report of the same problem. */
  duplicateOf: { publicId: string; status: ComplaintStatus; linkedAt: string } | null;
  /** How many other reports were linked to this one as duplicates. */
  linkedReportCount: number;
  /**
   * Staff and admins only. Staff get a pseudonym; admins also get the account ID and name.
   * Contact details are never included.
   */
  reporter?: { alias: string; id?: string; name?: string };
  /** Staff and admins only: rule-based spam signals (a flag for humans, never an automatic rejection). */
  spamCheck?: { score: number; signals: string[] } | null;
  /** Actions the caller may perform now; a UI hint only. The server re-checks every action. */
  allowedActions: ComplaintViewAction[];
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
  address?: string | null;
  selectedCategory?: Category | null;
  confirmedCategory?: Category | null;
  department?: Types.ObjectId | { _id: Types.ObjectId; name: string } | null;
  ward?: Types.ObjectId | { _id: Types.ObjectId; code: string; name: string } | null;
  priority?: Priority | null;
  status: ComplaintStatus;
  followUp?: { questions: string[]; answers: string[]; askedAt: Date; answeredAt?: Date | null } | null;
  duplicateOf?: { complaint: Types.ObjectId | { _id: Types.ObjectId; publicId: string; status: ComplaintStatus }; linkedAt: Date } | null;
  linkedReportCount?: number | null;
  spamCheck?: { score: number; signals: string[] } | null;
  routingReview?: { suggestedDepartment?: unknown } | null;
  statusHistory: { status: ComplaintStatus; at: Date; publicNote?: string | null }[];
  rejectionReason?: string | null;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const refId = (v: unknown) => (v && typeof v === 'object' && '_id' in v ? String((v as { _id: unknown })._id) : v ? String(v) : null);

/** Stable per-citizen pseudonym shown to department staff instead of the reporter's identity. */
export function reporterAlias(citizenId: string): string {
  return `Reporter #${createHash('sha256').update(`civicfix-reporter:${citizenId}`).digest('hex').slice(0, 6)}`;
}

const IN_TRIAGE: ComplaintStatus[] = ['REPORTED', 'UNDER_REVIEW'];

function allowedActions(p: Principal, c: ComplaintDoc, relation: Relation): ComplaintViewAction[] {
  const actions: ComplaintViewAction[] = [];
  if (isAdmin(p) && canTransition('classify', c.status)) actions.push('classify');
  if ((isAdmin(p) || managesDepartment(p, refId(c.department))) && canTransition('reject', c.status)) actions.push('reject');
  if (relation === 'reporter' && c.followUp && !c.followUp.answeredAt && !['CLOSED', 'REJECTED'].includes(c.status)) actions.push('answer_follow_up');
  const canLink = isAdmin(p) || managesDepartment(p, refId(c.department)) || (!c.department && p.memberships.some((m) => m.role === 'MANAGER'));
  if (canLink && relation !== 'reporter' && !c.duplicateOf && IN_TRIAGE.includes(c.status)) actions.push('link_duplicate');
  if (canLink && relation !== 'reporter' && c.duplicateOf) actions.push('unlink_duplicate');
  return actions;
}

function toView(p: Principal, c: ComplaintDoc, relation: Relation): ComplaintView {
  const dept = c.department && typeof c.department === 'object' && 'name' in c.department ? c.department : null;
  const ward = c.ward && typeof c.ward === 'object' && 'name' in c.ward ? c.ward : null;
  const canonical = c.duplicateOf?.complaint && typeof c.duplicateOf.complaint === 'object' && 'publicId' in c.duplicateOf.complaint ? c.duplicateOf.complaint : null;
  const view: ComplaintView = {
    id: String(c._id),
    publicId: c.publicId,
    title: c.title,
    description: c.description,
    location: { lat: c.location.coordinates[1]!, lng: c.location.coordinates[0]! },
    landmark: c.landmark ?? null,
    address: c.address ?? null,
    ward: ward ? { id: String(ward._id), code: ward.code, name: ward.name } : null,
    selectedCategory: c.selectedCategory ?? null,
    confirmedCategory: c.confirmedCategory ?? null,
    department: dept ? { id: String(dept._id), name: dept.name } : null,
    priority: c.priority ?? null,
    status: c.status,
    statusHistory: c.statusHistory.map((h) => ({ status: h.status, at: h.at.toISOString(), note: h.publicNote ?? null })),
    rejectionReason: c.rejectionReason ?? null,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    closedAt: c.closedAt?.toISOString() ?? null,
    followUp: c.followUp
      ? { questions: [...c.followUp.questions], answers: [...(c.followUp.answers ?? [])], askedAt: c.followUp.askedAt.toISOString(), answeredAt: c.followUp.answeredAt?.toISOString() ?? null }
      : null,
    duplicateOf: canonical && c.duplicateOf ? { publicId: canonical.publicId, status: canonical.status, linkedAt: c.duplicateOf.linkedAt.toISOString() } : null,
    linkedReportCount: c.linkedReportCount ?? 0,
    allowedActions: allowedActions(p, c, relation),
    createdAt: (c.createdAt ?? new Date()).toISOString(),
    updatedAt: (c.updatedAt ?? new Date()).toISOString(),
  };
  if (relation !== 'reporter') {
    const citizenId = refId(c.citizen)!;
    view.reporter = { alias: reporterAlias(citizenId) };
    if (relation === 'admin' && typeof c.citizen === 'object' && 'name' in c.citizen) {
      view.reporter.id = citizenId;
      view.reporter.name = c.citizen.name;
    }
    view.spamCheck = c.spamCheck ? { score: c.spamCheck.score, signals: [...c.spamCheck.signals] } : null;
  }
  return view;
}

const POPULATE = [
  { path: 'department', select: 'name' },
  { path: 'citizen', select: 'name' },
  { path: 'ward', select: 'code name' },
  { path: 'duplicateOf.complaint', select: 'publicId status' },
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
  /** Street address for a new complaint's location (best effort; capped at a few seconds). */
  lookupAddress?: (lat: number, lng: number) => Promise<string | null>;
  /** Called after the reporter answers follow-up questions while the complaint is still in triage. */
  onFollowUpAnswered?: (complaintId: Types.ObjectId) => Promise<unknown>;
  /** Called after a duplicate link is removed, so routing can be evaluated again. */
  onUnlinked?: (complaintId: Types.ObjectId) => Promise<unknown>;
  onHookError?: (err: unknown) => void;
  events?: EventBus;
}

/** Longest a submission waits for the address lookup (it is usually cached from the report form). */
const ADDRESS_WAIT_MS = 3000;

export function createComplaintService(hooks: ComplaintServiceHooks = {}) {
  async function addressFor(point: { lat: number; lng: number }): Promise<string | null> {
    if (!hooks.lookupAddress) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ADDRESS_WAIT_MS);
    });
    try {
      return await Promise.race([hooks.lookupAddress(point.lat, point.lng).catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Loads a complaint and the caller's relation to it, or 404 if it doesn't exist or isn't visible. */
  async function loadVisible(p: Principal, publicId: string) {
    const c = (await Complaint.findOne({ publicId }).populate([...POPULATE]).lean()) as ComplaintDoc | null;
    if (!c) throw notFound();
    const relation = relationTo(p, { citizen: refId(c.citizen), department: refId(c.department), routingReview: c.routingReview });
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
      const location = { type: 'Point' as const, coordinates: [input.location.lng, input.location.lat] };
      // Ward, address and spam signals are server-side facts; none can be set by the client.
      const [ward, spam, address] = await Promise.all([resolveWard(location), checkSpam(p.userId, { ...input, location }), addressFor(input.location)]);
      const seq = await nextSequence(`complaint-${year}`);
      const now = new Date();
      const complaint = await Complaint.create({
        ward: ward?._id,
        spamCheck: { score: spam.score, signals: spam.signals, checkedAt: now },
        publicId: `CF-${year}-${String(seq).padStart(5, '0')}`,
        citizen: p.userId, // always the authenticated user
        title: input.title,
        description: input.description,
        location,
        landmark: input.landmark,
        address: address ?? undefined,
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
      await hooks.events?.emit('complaint.created', { complaintId: String(complaint._id) }, `${complaint._id}:created`);
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
      if (before.status !== 'UNDER_REVIEW') {
        await hooks.events?.emit('complaint.status_changed', { complaintId: String(c._id), from: before.status, to: 'UNDER_REVIEW' }, `${c._id}:UNDER_REVIEW:classify`);
      }
      await hooks.events?.emit('assignment.review_required', { complaintId: String(c._id), departmentId: String(dept._id), reasons: [] }, `${c._id}:routed:${dept._id}:${Date.now()}`);
      return reload(p, c._id, relation);
    },

    /**
     * The reporter answers the AI's follow-up questions (once). While the complaint is still in triage the
     * answers trigger a fresh AI triage; afterwards they simply inform the field team.
     */
    async answerFollowUp(p: Principal, publicId: string, answers: string[], requestId: string): Promise<ComplaintView> {
      const { c, relation } = await loadVisible(p, publicId);
      if (relation !== 'reporter' && String(refId(c.citizen)) !== p.userId) throw new AppError('FORBIDDEN', 'Only the person who reported this can answer its questions.');
      if (!c.followUp) throw new AppError('CONFLICT', 'There are no questions to answer for this complaint.');
      if (c.followUp.answeredAt) throw new AppError('CONFLICT', 'These questions were already answered.');
      if (['CLOSED', 'REJECTED'].includes(c.status)) throw new AppError('CONFLICT', 'This complaint is closed.');
      if (answers.length !== c.followUp.questions.length) {
        throw validationError([{ field: 'body.answers', issue: 'invalid', message: `Give one answer per question (${c.followUp.questions.length}); use an empty string to skip one.` }]);
      }
      if (answers.every((a) => a.trim() === '')) throw validationError([{ field: 'body.answers', issue: 'invalid', message: 'Answer at least one question.' }]);
      const now = new Date();
      const updated = await Complaint.updateOne(
        { _id: c._id, 'followUp.answeredAt': null },
        { $set: { 'followUp.answers': answers.map((a) => a.trim()), 'followUp.answeredAt': now } },
        { runValidators: true },
      );
      if (updated.modifiedCount !== 1) throw new AppError('CONFLICT', 'These questions were already answered.');
      await auditUserAction({ actor: p, action: 'complaint.follow_up_answered', targetType: 'Complaint', targetId: c._id, requestId, changes: [{ field: 'answers', after: answers.filter((a) => a.trim()).length }] });
      if (IN_TRIAGE.includes(c.status) && !c.duplicateOf && hooks.onFollowUpAnswered) await hooks.onFollowUpAnswered(c._id).catch((err) => hooks.onHookError?.(err));
      return reload(p, c._id, relation);
    },

    /**
     * Links this report to another report of the same problem (the canonical one). Allowed while this
     * report is still in triage and has no open work order. Nothing is deleted: the duplicate keeps its
     * own text, photos and history, and its reporter can follow the canonical report's status.
     * Platform admins, or a manager of the canonical report's department (and of this report's, if routed).
     */
    async linkDuplicate(p: Principal, publicId: string, input: { canonicalPublicId: string; reason: string }, requestId: string): Promise<ComplaintView> {
      const { c, relation } = await loadVisible(p, publicId);
      if (relation === 'reporter') throw new AppError('FORBIDDEN', 'Only staff can link duplicate reports.');
      if (input.canonicalPublicId === c.publicId) throw validationError([{ field: 'body.canonicalPublicId', issue: 'invalid', message: 'A report cannot be a duplicate of itself.' }]);
      const canonical = await Complaint.findOne({ publicId: input.canonicalPublicId }).select('citizen department status duplicateOf publicId').lean();
      if (!canonical || !relationTo(p, { citizen: canonical.citizen, department: canonical.department })) throw notFoundError('The original complaint');
      const ownDept = refId(c.department);
      const allowed = isAdmin(p) || (managesDepartment(p, refId(canonical.department)) && (!ownDept || managesDepartment(p, ownDept)));
      if (!allowed) throw new AppError('FORBIDDEN', 'Only platform administrators or a manager of the original report’s department can link duplicates.');
      if (c.duplicateOf) throw new AppError('CONFLICT', 'This report is already linked to another report.');
      if (canonical.duplicateOf) throw new AppError('CONFLICT', 'That report is itself a duplicate. Link to the original report instead.');
      if (canonical.status === 'REJECTED') throw new AppError('CONFLICT', 'You cannot link to a rejected report.');
      if (!IN_TRIAGE.includes(c.status)) throw new AppError('CONFLICT', `A report that is ${c.status} can't be linked as a duplicate.`);
      if (await WorkOrder.exists({ activeFor: c._id })) throw new AppError('CONFLICT', 'This report already has an open work order. Cancel it first.');

      const now = new Date();
      const linked = await Complaint.findOneAndUpdate(
        { _id: c._id, status: { $in: IN_TRIAGE }, duplicateOf: null },
        {
          $set: { duplicateOf: { complaint: canonical._id, source: 'MANAGER', linkedBy: p.userId, linkedAt: now, reason: input.reason } },
          $unset: { routingReview: 1 },
          $push: { statusHistory: { status: c.status, at: now, publicNote: `Linked to ${canonical.publicId}, an earlier report of the same problem. You'll see its progress here.` } },
        },
        { runValidators: true },
      );
      if (!linked) throw new AppError('CONFLICT', 'The report changed while you were linking it. Reload and try again.');
      await Complaint.updateOne({ _id: canonical._id }, { $inc: { linkedReportCount: 1 } });
      await auditUserAction({ actor: p, action: 'complaint.duplicate_linked', targetType: 'Complaint', targetId: c._id, requestId, reason: input.reason, changes: [{ field: 'duplicateOf', after: canonical.publicId }] });
      await hooks.events?.emit('complaint.duplicate_linked', { complaintId: String(c._id), canonicalId: String(canonical._id) }, `${c._id}:dup:${canonical._id}:${now.getTime()}`);
      return reload(p, c._id, relation);
    },

    /** Removes a duplicate link (same people as linking). The report goes back to routing. */
    async unlinkDuplicate(p: Principal, publicId: string, reason: string, requestId: string): Promise<ComplaintView> {
      const { c, relation } = await loadVisible(p, publicId);
      if (relation === 'reporter') throw new AppError('FORBIDDEN', 'Only staff can unlink duplicate reports.');
      if (!c.duplicateOf) throw new AppError('CONFLICT', 'This report is not linked to another report.');
      const canonicalId = refId(c.duplicateOf.complaint)!;
      const canonical = await Complaint.findById(canonicalId).select('department publicId').lean();
      const ownDept = refId(c.department);
      const allowed = isAdmin(p) || (managesDepartment(p, refId(canonical?.department)) && (!ownDept || managesDepartment(p, ownDept)));
      if (!allowed) throw new AppError('FORBIDDEN', 'Only platform administrators or a manager of the original report’s department can unlink duplicates.');
      const now = new Date();
      const res = await Complaint.updateOne(
        { _id: c._id, 'duplicateOf.complaint': canonicalId },
        { $unset: { duplicateOf: 1 }, $push: { statusHistory: { status: c.status, at: now, publicNote: 'This report is being handled on its own again.' } } },
      );
      if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'The report changed while you were unlinking it. Reload and try again.');
      await Complaint.updateOne({ _id: canonicalId, linkedReportCount: { $gt: 0 } }, { $inc: { linkedReportCount: -1 } });
      await auditUserAction({ actor: p, action: 'complaint.duplicate_unlinked', targetType: 'Complaint', targetId: c._id, requestId, reason, changes: [{ field: 'duplicateOf', before: canonical?.publicId ?? canonicalId, after: null }] });
      if (hooks.onUnlinked) await hooks.onUnlinked(c._id).catch((err) => hooks.onHookError?.(err));
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
      await hooks.events?.emit('complaint.status_changed', { complaintId: String(c._id), from: c.status, to: 'REJECTED', note: reason }, `${c._id}:REJECTED`);
      return reload(p, c._id, relation);
    },
  };
}
export type ComplaintService = ReturnType<typeof createComplaintService>;
