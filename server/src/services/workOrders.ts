import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { EventBus } from '../events/bus.js';
import type { Category, ComplaintStatus, Priority, ReviewReason, WorkOrderStatus } from '../models/enums.js';
import { AIAnalysis, AuditLog, Complaint, Department, DepartmentMembership, User, WorkOrder, nextSequence } from '../models/index.js';
import { COMPLAINT_STATUS_FOR_WORK_ORDER, complaintActionFor } from '../policies/complaintLifecycle.js';
import { OPEN_WORK_ORDER_STATUSES, WORK_ORDER_TRANSITIONS, canWorkOrderTransition, type WorkOrderAction } from '../policies/workOrderLifecycle.js';
import { AppError, notFoundError, validationError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { paginationMeta, toSkipLimit, type PaginationMeta, type PaginationQuery } from '../validation/pagination.js';
import { auditUserAction, type AuditChange } from './audit.js';
import type { ComplaintService } from './complaints.js';

// ---- policy ---------------------------------------------------------------------------

export interface AssignmentPolicy {
  version: string;
  /** Master switch for automatic routing. When off, every case goes to human review. */
  autoAssignEnabled: boolean;
  /** Members with this many open work orders are skipped when picking an assignee automatically. */
  maxOpenWorkOrdersPerMember: number;
  /** Target completion time by priority (hours). Used for dueAt and "overdue". Needs product-owner sign-off. */
  dueHoursByPriority: Record<Priority, number>;
}

export const DEFAULT_ASSIGNMENT_POLICY: AssignmentPolicy = {
  version: 'assign-v1',
  autoAssignEnabled: true,
  maxOpenWorkOrdersPerMember: 10,
  dueHoursByPriority: { P1: 24, P2: 72, P3: 168, P4: 336 },
};

/** Citizen-facing note for each complaint status reached through work-order events. */
const PUBLIC_NOTES: Partial<Record<ComplaintStatus, string>> = {
  ASSIGNED: 'A department team has been given this work.',
  ACCEPTED: 'The assigned team has accepted the work.',
  IN_PROGRESS: 'Work is in progress.',
  BLOCKED: 'Work is paused. The team has recorded the reason and the next step.',
  UNDER_REVIEW: 'Sent back for review so it can be routed to the right team.',
  RESOLUTION_SUBMITTED: 'The team says the work is done and has sent evidence. It is being checked.',
  VERIFICATION_REQUIRED: 'The evidence needs a closer look by a manager before we close this.',
  RESOLVED: 'The fix has been checked and confirmed.',
};

// ---- authority -----------------------------------------------------------------------------

type WorkOrderDoc = {
  _id: Types.ObjectId;
  publicId?: string | null;
  complaint: Types.ObjectId;
  department: Types.ObjectId;
  priority: Priority;
  status: WorkOrderStatus;
  assignee?: Types.ObjectId | null;
  [k: string]: unknown;
};

const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');
const isManagerOf = (p: Principal, dept: string) => p.memberships.some((m) => m.departmentId === dept && m.role === 'MANAGER');
const isMemberOf = (p: Principal, dept: string) => p.memberships.some((m) => m.departmentId === dept);

export type WorkOrderRole = 'ADMIN' | 'MANAGER' | 'ASSIGNEE' | 'MEMBER';

/** All roles the caller holds on this work order. Empty means no access (404). */
export function rolesOn(p: Principal, wo: { department: unknown; assignee?: unknown }): Set<WorkOrderRole> {
  const dept = String(wo.department);
  const roles = new Set<WorkOrderRole>();
  if (isAdmin(p)) roles.add('ADMIN');
  if (isManagerOf(p, dept)) roles.add('MANAGER');
  // Assignee rights require the assignment AND a still-active membership in the department.
  if (wo.assignee && String(wo.assignee) === p.userId && isMemberOf(p, dept)) roles.add('ASSIGNEE');
  if (isMemberOf(p, dept)) roles.add('MEMBER');
  return roles;
}

function allowedActions(roles: Set<WorkOrderRole>, wo: WorkOrderDoc): WorkOrderAction[] {
  const out: WorkOrderAction[] = [];
  for (const [action, t] of Object.entries(WORK_ORDER_TRANSITIONS) as [WorkOrderAction, (typeof WORK_ORDER_TRANSITIONS)[WorkOrderAction]][]) {
    if (!canWorkOrderTransition(action, wo.status)) continue;
    const actors = t.actors as readonly string[];
    const verifier = (roles.has('MANAGER') || roles.has('ADMIN')) && !roles.has('ASSIGNEE');
    if (actors.some((a) => (a === 'VERIFIER' ? verifier : roles.has(a as WorkOrderRole)))) out.push(action);
  }
  return out;
}

// ---- service -------------------------------------------------------------------------------

export interface WorkOrderServiceDeps {
  logger: Logger;
  events: EventBus;
  complaints: ComplaintService;
  policy?: AssignmentPolicy;
}

export interface ManualAssignInput {
  departmentId: string;
  category?: Category;
  priority: Priority;
  assigneeId?: string;
  reason: string;
}

export interface ListWorkOrdersQuery extends PaginationQuery {
  scope: 'mine' | 'department' | 'all';
  sort: Record<string, 1 | -1>;
  status?: WorkOrderStatus[];
  departmentId?: string;
  priority?: Priority;
  overdue?: boolean;
}

type Actor = { principal: Principal } | { system: true };
const actorFields = (a: Actor) => ('principal' in a ? { actorType: 'USER' as const, actor: new Types.ObjectId(a.principal.userId) } : { actorType: 'SYSTEM' as const });

export function createWorkOrderService(deps: WorkOrderServiceDeps) {
  const { logger, events } = deps;
  const policy = deps.policy ?? DEFAULT_ASSIGNMENT_POLICY;

  async function audit(actor: Actor, action: string, targetType: 'Complaint' | 'WorkOrder', targetId: Types.ObjectId, opts: { reason?: string; changes?: AuditChange[]; requestId?: string } = {}) {
    if ('principal' in actor) {
      await auditUserAction({ actor: actor.principal, action, targetType, targetId, requestId: opts.requestId ?? '', reason: opts.reason, changes: opts.changes });
    } else {
      await AuditLog.create({ actorType: 'SYSTEM', action, targetType, targetId, outcome: 'SUCCESS', reason: opts.reason, changes: opts.changes ?? [] });
    }
  }

  const dueAtFor = (priority: Priority, from = new Date()) => new Date(from.getTime() + policy.dueHoursByPriority[priority] * 3_600_000);

  /** Active members of a department with an active account; optionally a specific user. */
  async function eligibleAssignee(departmentId: string, userId: string): Promise<boolean> {
    const m = await DepartmentMembership.exists({ department: departmentId, user: userId, status: 'ACTIVE' });
    if (!m) return false;
    return !!(await User.exists({ _id: userId, accountStatus: 'ACTIVE' }));
  }

  /**
   * Deterministic pick: active MEMBER (not manager) with an active account and fewer than
   * maxOpenWorkOrdersPerMember open work orders; fewest open work first, then longest-standing membership.
   */
  async function pickAssignee(departmentId: Types.ObjectId): Promise<Types.ObjectId | null> {
    const memberships = await DepartmentMembership.find({ department: departmentId, status: 'ACTIVE', role: 'MEMBER' }).sort({ createdAt: 1, _id: 1 }).select('user').limit(200).lean();
    if (memberships.length === 0) return null;
    const active = new Set((await User.find({ _id: { $in: memberships.map((m) => m.user) }, accountStatus: 'ACTIVE' }).select('_id').lean()).map((u) => String(u._id)));
    const loads = await WorkOrder.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { assignee: { $in: memberships.map((m) => m.user) }, status: { $in: OPEN_WORK_ORDER_STATUSES } } },
      { $group: { _id: '$assignee', n: { $sum: 1 } } },
    ]);
    const load = new Map(loads.map((l) => [String(l._id), l.n]));
    const candidates = memberships
      .filter((m) => active.has(String(m.user)) && (load.get(String(m.user)) ?? 0) < policy.maxOpenWorkOrdersPerMember)
      .map((m, order) => ({ user: m.user, n: load.get(String(m.user)) ?? 0, order }))
      .sort((a, b) => a.n - b.n || a.order - b.order);
    return candidates[0]?.user ?? null;
  }

  /** Moves the complaint to mirror a work-order change. Returns false if the complaint wasn't in the expected state. */
  async function mirrorComplaint(complaintId: Types.ObjectId, fromWo: WorkOrderStatus | null, toWo: WorkOrderStatus, extraSet: Record<string, unknown> = {}, extraUnset: Record<string, 1> = {}, note?: string) {
    const to = COMPLAINT_STATUS_FOR_WORK_ORDER[toWo];
    const fromStatuses: ComplaintStatus[] = fromWo ? [COMPLAINT_STATUS_FOR_WORK_ORDER[fromWo]] : ['REPORTED', 'UNDER_REVIEW'];
    const now = new Date();
    if (fromStatuses.length === 1 && fromStatuses[0] === to) {
      if (Object.keys(extraSet).length || Object.keys(extraUnset).length) {
        await Complaint.updateOne({ _id: complaintId }, { ...(Object.keys(extraSet).length && { $set: extraSet }), ...(Object.keys(extraUnset).length && { $unset: extraUnset }) });
      }
      return { ok: true, from: to, to, changed: false };
    }
    for (const from of fromStatuses) {
      if (!complaintActionFor(from, to)) throw new Error(`No complaint transition ${from} -> ${to}`);
    }
    const res = await Complaint.findOneAndUpdate(
      { _id: complaintId, status: { $in: fromStatuses } },
      {
        $set: { ...extraSet, status: to, ...(to === 'RESOLVED' && { resolvedAt: now }) },
        ...(Object.keys(extraUnset).length && { $unset: extraUnset }),
        $push: { statusHistory: { status: to, at: now, publicNote: note ?? PUBLIC_NOTES[to] } },
      },
      { runValidators: true },
    ).lean();
    if (!res) return { ok: false, from: fromStatuses[0]!, to, changed: false };
    return { ok: true, from: res.status, to, changed: true };
  }

  /**
   * Applies one work-order transition atomically (conditional on the current status and, if given,
   * the current assignee), then mirrors it onto the complaint. If the complaint can't follow, the
   * work-order change is reverted and the caller gets 409, so the two never disagree.
   */
  async function transition(
    wo: WorkOrderDoc,
    action: WorkOrderAction,
    actor: Actor,
    opts: { set?: Record<string, unknown>; unset?: string[]; reason?: string; guard?: Record<string, unknown>; complaintSet?: Record<string, unknown>; complaintUnset?: string[]; note?: string; requestId?: string } = {},
  ) {
    const t = WORK_ORDER_TRANSITIONS[action];
    if (!canWorkOrderTransition(action, wo.status)) throw new AppError('CONFLICT', `A work order that is ${wo.status} can't be ${action.replace(/_/g, ' ')}.`);
    const to = t.to as WorkOrderStatus;
    const now = new Date();
    const terminal = to === 'COMPLETED' || to === 'CANCELLED';
    const unset: Record<string, 1> = Object.fromEntries((opts.unset ?? []).map((k) => [k, 1]));
    if (terminal) unset.activeFor = 1;
    const set: Record<string, unknown> = { ...opts.set, status: to };
    if (!terminal && (wo.status === 'COMPLETED' || wo.status === 'CANCELLED')) set.activeFor = wo.complaint;

    let updated;
    try {
      updated = await WorkOrder.findOneAndUpdate(
        { _id: wo._id, status: wo.status, ...opts.guard },
        {
          $set: set,
          ...(Object.keys(unset).length && { $unset: unset }),
          $push: {
            history: {
              at: now,
              action,
              ...actorFields(actor),
              fromStatus: wo.status,
              toStatus: to,
              department: (opts.set?.department as Types.ObjectId | undefined) ?? wo.department,
              assignee: (opts.set?.assignee as Types.ObjectId | undefined) ?? (unset.assignee ? undefined : wo.assignee ?? undefined),
              reason: opts.reason,
            },
          },
        },
        { returnDocument: 'after', runValidators: true },
      ).lean();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'This complaint already has an open work order.');
      throw err;
    }
    if (!updated) throw new AppError('CONFLICT', 'The work order changed while you were working on it. Reload and try again.');

    const complaintUnset = Object.fromEntries((opts.complaintUnset ?? []).map((k) => [k, 1 as const]));
    const mirrored = await mirrorComplaint(wo.complaint, wo.status, to, opts.complaintSet, complaintUnset, opts.note);
    if (!mirrored.ok) {
      // Compensate: put the work order back exactly as it was.
      await WorkOrder.updateOne(
        { _id: wo._id, status: to },
        {
          $set: { status: wo.status, ...(terminal && { activeFor: wo.complaint }) },
          $push: { history: { at: new Date(), action: 'reverted', actorType: 'SYSTEM', fromStatus: to, toStatus: wo.status, reason: 'complaint state changed concurrently' } },
        },
      );
      throw new AppError('CONFLICT', 'The complaint changed at the same time. Nothing was saved; reload and try again.');
    }

    await audit(actor, `work_order.${action}`, 'WorkOrder', wo._id, {
      reason: opts.reason,
      requestId: opts.requestId,
      changes: [{ field: 'status', before: wo.status, after: to }],
    });
    const actorId = 'principal' in actor ? actor.principal.userId : null;
    await events.emit('work_order.status_changed', { workOrderId: String(wo._id), from: wo.status, to, actorId }, `${wo._id}:${action}:${now.getTime()}`);
    if (mirrored.changed) {
      await events.emit('complaint.status_changed', { complaintId: String(wo.complaint), from: mirrored.from, to: mirrored.to, note: opts.note ?? PUBLIC_NOTES[mirrored.to] }, `${wo.complaint}:${mirrored.to}:${now.getTime()}`);
    }
    return updated as unknown as WorkOrderDoc;
  }

  /** Creates the work order and moves the complaint to ASSIGNED; undoes the work order if the complaint can't follow. */
  async function createWorkOrder(opts: {
    complaintId: Types.ObjectId;
    departmentId: Types.ObjectId;
    priority: Priority;
    category: Category;
    source: 'AUTO' | 'MANAGER' | 'ADMIN_OVERRIDE';
    actor: Actor;
    reason: string;
    assigneeId?: Types.ObjectId | null;
    autoPick: boolean;
    requestId?: string;
  }) {
    const now = new Date();
    let assignee = opts.assigneeId ?? null;
    if (!assignee && opts.autoPick) assignee = await pickAssignee(opts.departmentId);
    const year = now.getUTCFullYear();
    const publicId = `WO-${year}-${String(await nextSequence(`workorder-${year}`)).padStart(5, '0')}`;
    const actorF = actorFields(opts.actor);
    const history = [{ at: now, action: 'created', ...actorF, toStatus: 'PENDING_ASSIGNMENT', department: opts.departmentId, reason: opts.reason, policyVersion: policy.version }];
    if (assignee) history.push({ at: now, action: 'assign_staff', ...actorF, fromStatus: 'PENDING_ASSIGNMENT', toStatus: 'ASSIGNED', department: opts.departmentId, assignee, reason: opts.reason, policyVersion: policy.version } as never);

    let wo;
    try {
      wo = await WorkOrder.create({
        publicId,
        complaint: opts.complaintId,
        activeFor: opts.complaintId,
        department: opts.departmentId,
        priority: opts.priority,
        status: assignee ? 'ASSIGNED' : 'PENDING_ASSIGNMENT',
        assignee: assignee ?? undefined,
        assignedBy: 'principal' in opts.actor ? opts.actor.principal.userId : undefined,
        assignmentSource: opts.source,
        assignmentReason: opts.reason,
        assignedAt: now,
        dueAt: dueAtFor(opts.priority, now),
        // Only automatic routing that found nobody records NO_ELIGIBLE_MEMBER; a human who routed without
        // naming someone simply leaves the pick to the department manager.
        managerReview: !assignee && opts.autoPick ? { reasons: ['NO_ELIGIBLE_MEMBER'], requestedAt: now } : undefined,
        history,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'This complaint already has an open work order.');
      throw err;
    }

    const dept = await Department.findById(opts.departmentId).select('name').lean();
    const mirrored = await mirrorComplaint(
      opts.complaintId,
      null,
      'ASSIGNED',
      { department: opts.departmentId, confirmedCategory: opts.category, priority: opts.priority },
      { routingReview: 1 },
      `Assigned to ${dept?.name ?? 'a department'}.`,
    );
    if (!mirrored.ok) {
      await WorkOrder.deleteOne({ _id: wo._id }); // brand new, nothing else refers to it yet
      throw new AppError('CONFLICT', 'The complaint is no longer waiting for assignment.');
    }

    await audit(opts.actor, 'assignment.decided', 'Complaint', opts.complaintId, {
      reason: opts.reason,
      requestId: opts.requestId,
      changes: [
        { field: 'department', after: String(opts.departmentId) },
        { field: 'source', after: opts.source },
        { field: 'policyVersion', after: policy.version },
        { field: 'workOrder', after: publicId },
      ],
    });
    await events.emit('work_order.created', { workOrderId: String(wo._id), complaintId: String(opts.complaintId), departmentId: String(opts.departmentId), source: opts.source }, `${wo._id}:created`);
    await events.emit('complaint.status_changed', { complaintId: String(opts.complaintId), from: mirrored.from, to: 'ASSIGNED' }, `${opts.complaintId}:ASSIGNED:${wo._id}`);
    if (assignee) await events.emit('work_order.assigned', { workOrderId: String(wo._id), assigneeId: String(assignee) }, `${wo._id}:assigned:${assignee}`);
    return wo;
  }

  // ---- views ----

  async function toView(p: Principal, wo: WorkOrderDoc) {
    const roles = rolesOn(p, wo);
    const userIds = new Set<string>();
    if (wo.assignee) userIds.add(String(wo.assignee));
    for (const n of (wo.notes as { author: unknown }[]) ?? []) userIds.add(String(n.author));
    const [users, dept, complaint] = await Promise.all([
      User.find({ _id: { $in: [...userIds] } }).select('name').lean(),
      Department.findById(wo.department).select('name').lean(),
      Complaint.findById(wo.complaint).select('publicId title status landmark location').lean(),
    ]);
    const name = (id: unknown) => users.find((u) => String(u._id) === String(id))?.name ?? null;
    const now = Date.now();
    const dueAt = wo.dueAt as Date | undefined;
    return {
      id: String(wo._id),
      publicId: wo.publicId ?? null,
      complaint: complaint
        ? { publicId: complaint.publicId, title: complaint.title, status: complaint.status, landmark: complaint.landmark ?? null, location: { lat: complaint.location.coordinates[1], lng: complaint.location.coordinates[0] } }
        : null,
      department: dept ? { id: String(dept._id), name: dept.name } : null,
      priority: wo.priority,
      status: wo.status,
      assignee: wo.assignee ? { id: String(wo.assignee), name: name(wo.assignee) } : null,
      assignmentSource: (wo.assignmentSource as string) ?? null,
      assignmentReason: (wo.assignmentReason as string) ?? null,
      assignedAt: (wo.assignedAt as Date | undefined)?.toISOString() ?? null,
      dueAt: dueAt?.toISOString() ?? null,
      overdue: !!dueAt && dueAt.getTime() < now && OPEN_WORK_ORDER_STATUSES.includes(wo.status),
      reviewRequired: wo.managerReview && !(wo.managerReview as { decision?: string }).decision ? (wo.managerReview as { reasons: string[] }).reasons : [],
      acceptedAt: (wo.acceptedAt as Date | undefined)?.toISOString() ?? null,
      startedAt: (wo.startedAt as Date | undefined)?.toISOString() ?? null,
      blocked: wo.status === 'BLOCKED' ? { reason: wo.blockedReason, nextAction: wo.blockedNextAction, since: (wo.blockedAt as Date | undefined)?.toISOString() ?? null } : null,
      notes: ((wo.notes as { author: unknown; text: string; at: Date }[]) ?? []).map((n) => ({ author: { id: String(n.author), name: name(n.author) }, text: n.text, at: n.at.toISOString() })),
      history: ((wo.history as { at: Date; action: string; actorType: string; fromStatus?: string; toStatus?: string; reason?: string }[]) ?? []).map((h) => ({
        at: h.at.toISOString(),
        action: h.action,
        actorType: h.actorType,
        fromStatus: h.fromStatus ?? null,
        toStatus: h.toStatus ?? null,
        reason: h.reason ?? null,
      })),
      completionNotes: (wo.completionNotes as string) ?? null,
      resolutionSubmittedAt: (wo.resolutionSubmittedAt as Date | undefined)?.toISOString() ?? null,
      resolutionEvidence: ((wo.resolutionEvidence as unknown[]) ?? []).map(String),
      verificationDecision: wo.verificationDecision
        ? (({ decision, source, decidedAt, reason }) => ({ decision, source, decidedAt: decidedAt.toISOString(), reason }))(wo.verificationDecision as { decision: string; source: string; decidedAt: Date; reason: string })
        : null,
      cancelled: wo.status === 'CANCELLED' ? { at: (wo.cancelledAt as Date | undefined)?.toISOString() ?? null, reason: wo.cancelReason ?? null } : null,
      completedAt: (wo.completedAt as Date | undefined)?.toISOString() ?? null,
      allowedActions: allowedActions(roles, wo),
      createdAt: (wo.createdAt as Date).toISOString(),
      updatedAt: (wo.updatedAt as Date).toISOString(),
    };
  }

  /** Loads by public ID (WO-…) or ObjectId; 404 unless the caller is admin or in the department. */
  async function load(p: Principal, id: string) {
    const filter = /^[0-9a-f]{24}$/i.test(id) ? { _id: id } : { publicId: id.toUpperCase() };
    const wo = (await WorkOrder.findOne(filter).lean()) as WorkOrderDoc | null;
    if (!wo) throw notFoundError('The work order');
    const roles = rolesOn(p, wo);
    if (roles.size === 0) throw notFoundError('The work order');
    return { wo, roles };
  }

  const need = (roles: Set<WorkOrderRole>, allowed: WorkOrderRole[], message: string) => {
    if (!allowed.some((r) => roles.has(r))) throw new AppError('FORBIDDEN', message);
  };

  async function validateDepartmentFor(departmentId: string, category: Category, field = 'body.departmentId') {
    const dept = await Department.findById(departmentId).select('name categories isActive').lean();
    if (!dept || !dept.isActive) throw validationError([{ field, issue: 'invalid', message: 'No active department with this ID.' }]);
    if (!dept.categories.includes(category)) throw validationError([{ field, issue: 'invalid', message: `This department does not handle "${category}".` }]);
    return dept;
  }

  return {
    policy,
    rolesOn,
    load,
    toView,
    transition,
    audit,

    /**
     * Rule-based automatic routing. Runs after AI jobs finish; safe to call any number of times.
     * Assigns only when every rule passes; otherwise records why a human must decide.
     */
    async evaluateAutoAssignment(complaintId: Types.ObjectId | string): Promise<{ outcome: 'ASSIGNED' | 'REVIEW' | 'SKIPPED'; reasons?: ReviewReason[] }> {
      const complaint = await Complaint.findById(complaintId).lean();
      if (!complaint || !['REPORTED', 'UNDER_REVIEW'].includes(complaint.status)) return { outcome: 'SKIPPED' };
      if (complaint.department) return { outcome: 'SKIPPED' }; // already routed by a human; the manager decides
      if (await WorkOrder.exists({ activeFor: complaint._id })) return { outcome: 'SKIPPED' };

      const [triage, dup] = await Promise.all([
        AIAnalysis.findOne({ complaint: complaint._id, analysisType: 'TRIAGE' }).sort({ analysisVersion: -1 }).lean(),
        AIAnalysis.findOne({ complaint: complaint._id, analysisType: 'DUPLICATE_CANDIDATES' }).sort({ analysisVersion: -1 }).lean(),
      ]);
      if ([triage?.status, dup?.status].some((s) => s === 'PENDING' || s === 'RUNNING')) return { outcome: 'SKIPPED' }; // wait for both

      const reasons = new Set<ReviewReason>();
      if (!policy.autoAssignEnabled) reasons.add('POLICY_REQUIRES_APPROVAL');
      let department: { _id: Types.ObjectId } | null = null;
      if (!triage || triage.status !== 'SUCCEEDED' || !triage.suggestedCategory || !triage.suggestedPriority) {
        reasons.add('AI_UNAVAILABLE');
      } else {
        for (const f of triage.reviewFlags ?? []) reasons.add(f);
        if (triage.certainty !== 'HIGH') reasons.add('LOW_CONFIDENCE');
        if (triage.reviewRecommended && reasons.size === 0) reasons.add('POLICY_REQUIRES_APPROVAL');
        if (triage.suggestedPriority === 'P1') reasons.add('HIGH_URGENCY');
        if (complaint.selectedCategory && complaint.selectedCategory !== triage.suggestedCategory) reasons.add('CATEGORY_CONFLICT');
        // The data-driven mapping: exactly one active department must handle the category, and it must be the suggested one.
        const handlers = await Department.find({ isActive: true, categories: triage.suggestedCategory }).select('_id').limit(2).lean();
        if (handlers.length === 0) reasons.add('UNCLEAR_DEPARTMENT');
        else if (handlers.length > 1) reasons.add('MULTI_DEPARTMENT');
        else if (!triage.suggestedDepartment || !handlers[0]!._id.equals(triage.suggestedDepartment)) reasons.add('UNCLEAR_DEPARTMENT');
        else department = handlers[0]!;
      }
      if (!dup || dup.status !== 'SUCCEEDED' || (dup.duplicateCandidates ?? []).length > 0) reasons.add('AMBIGUOUS_DUPLICATE');

      if (reasons.size > 0 || !department || !triage) {
        const list = [...reasons];
        const updated = await Complaint.updateOne(
          { _id: complaint._id, status: { $in: ['REPORTED', 'UNDER_REVIEW'] }, department: null },
          { $set: { routingReview: { reasons: list, evaluatedAt: new Date(), policyVersion: policy.version } } },
        );
        if (updated.modifiedCount === 1) {
          await audit({ system: true }, 'assignment.review_required', 'Complaint', complaint._id, { reason: list.join(', ') });
          await events.emit('assignment.review_required', { complaintId: String(complaint._id), departmentId: null, reasons: list }, `${complaint._id}:review:${triage?._id ?? 'none'}:${dup?._id ?? 'none'}`);
        }
        return { outcome: 'REVIEW', reasons: list };
      }

      try {
        await createWorkOrder({
          complaintId: complaint._id,
          departmentId: department._id,
          priority: triage.suggestedPriority!,
          category: triage.suggestedCategory as Category,
          source: 'AUTO',
          actor: { system: true },
          reason: `Automatic routing (${policy.version}): high-certainty classification, single responsible department, no duplicates.`,
          autoPick: true,
        });
      } catch (err) {
        if (err instanceof AppError && err.code === 'CONFLICT') return { outcome: 'SKIPPED' }; // someone else got there first
        throw err;
      }
      logger.info({ complaintId: String(complaint._id) }, 'complaint assigned automatically');
      return { outcome: 'ASSIGNED' };
    },

    /** Human routing decision: admin for any department, manager only for a complaint already routed to their department. */
    async assignComplaint(p: Principal, publicId: string, input: ManualAssignInput, requestId: string) {
      const { complaintId, departmentId: currentDept, relation } = await deps.complaints.access(p, publicId);
      const complaint = await Complaint.findById(complaintId).lean();
      if (!complaint) throw notFoundError('The complaint');
      const admin = isAdmin(p);
      if (!admin) {
        if (relation !== 'staff' || !currentDept || !isManagerOf(p, currentDept)) throw new AppError('FORBIDDEN', 'Only platform administrators or this department’s managers can assign this complaint.');
        if (input.departmentId !== currentDept) throw new AppError('FORBIDDEN', 'Managers can only assign within their own department. Ask an administrator to move it.');
      }
      if (!['REPORTED', 'UNDER_REVIEW'].includes(complaint.status)) throw new AppError('CONFLICT', `A complaint that is ${complaint.status} can't be assigned.`);
      const category = (input.category ?? complaint.confirmedCategory ?? complaint.selectedCategory) as Category | undefined;
      if (!category) throw validationError([{ field: 'body.category', issue: 'required', message: 'Choose a category for this complaint.' }]);
      const dept = await validateDepartmentFor(input.departmentId, category);
      if (input.assigneeId && !(await eligibleAssignee(input.departmentId, input.assigneeId))) {
        throw validationError([{ field: 'body.assigneeId', issue: 'invalid', message: 'The assignee must be an active member of the department.' }]);
      }
      const wo = await createWorkOrder({
        complaintId,
        departmentId: dept._id,
        priority: input.priority,
        category,
        source: admin ? 'ADMIN_OVERRIDE' : 'MANAGER',
        actor: { principal: p },
        reason: input.reason,
        assigneeId: input.assigneeId ? new Types.ObjectId(input.assigneeId) : null,
        autoPick: false,
        requestId,
      });
      return toView(p, wo.toObject() as unknown as WorkOrderDoc);
    },

    /** Complaints waiting for a routing decision, scoped to what the caller may decide. */
    async reviewQueue(p: Principal, q: PaginationQuery) {
      const managed = p.memberships.filter((m) => m.role === 'MANAGER').map((m) => new Types.ObjectId(m.departmentId));
      let scope: Record<string, unknown>;
      if (isAdmin(p)) scope = {};
      else if (managed.length > 0) scope = { department: { $in: managed } };
      else throw new AppError('FORBIDDEN', 'Only managers and platform administrators have a review queue.');
      const filter: Record<string, unknown> = { ...scope, status: { $in: ['REPORTED', 'UNDER_REVIEW'] } };
      const { skip, limit } = toSkipLimit(q);
      const [rawDocs, total] = await Promise.all([
        Complaint.find(filter).sort({ createdAt: 1, _id: 1 }).skip(skip).limit(limit).select('publicId title status selectedCategory confirmedCategory priority department routingReview createdAt').populate('department', 'name').lean(),
        Complaint.countDocuments(filter),
      ]);
      type QueueDoc = {
        publicId: string;
        title: string;
        status: string;
        selectedCategory?: string | null;
        confirmedCategory?: string | null;
        priority?: string | null;
        department?: unknown;
        routingReview?: { reasons: string[]; evaluatedAt: Date } | null;
        createdAt?: Date;
      };
      const docs = rawDocs as unknown as QueueDoc[];
      const items = docs.map((c) => ({
        publicId: c.publicId,
        title: c.title,
        status: c.status,
        category: c.confirmedCategory ?? c.selectedCategory ?? null,
        priority: c.priority ?? null,
        department: (() => {
          const d = c.department as { _id?: unknown; name?: string } | null | undefined;
          return d && typeof d === 'object' && d.name ? { id: String(d._id), name: d.name } : null;
        })(),
        reviewReasons: c.routingReview?.reasons ?? [],
        evaluatedAt: c.routingReview?.evaluatedAt?.toISOString() ?? null,
        createdAt: c.createdAt!.toISOString(),
      }));
      return { items, pagination: paginationMeta(q, total) };
    },

    async list(p: Principal, q: ListWorkOrdersQuery): Promise<{ items: Awaited<ReturnType<typeof toView>>[]; pagination: PaginationMeta }> {
      let scope: Record<string, unknown>;
      const mine = p.memberships.map((m) => m.departmentId);
      if (q.scope === 'mine') scope = { assignee: new Types.ObjectId(p.userId), department: { $in: mine.map((d) => new Types.ObjectId(d)) } };
      else if (q.scope === 'department') {
        if (q.departmentId && !mine.includes(q.departmentId) && !isAdmin(p)) throw new AppError('FORBIDDEN', 'You are not a member of that department.');
        const ids = q.departmentId ? [q.departmentId] : mine;
        if (ids.length === 0) throw new AppError('FORBIDDEN', 'You are not an active member of any department.');
        scope = { department: { $in: ids.map((d) => new Types.ObjectId(d)) } };
      } else {
        if (!isAdmin(p)) throw new AppError('FORBIDDEN', 'Only platform administrators can list all work orders.');
        scope = q.departmentId ? { department: new Types.ObjectId(q.departmentId) } : {};
      }
      const filters: Record<string, unknown>[] = [scope];
      if (q.status?.length) filters.push({ status: { $in: q.status } });
      if (q.priority) filters.push({ priority: q.priority });
      if (q.overdue) filters.push({ dueAt: { $lt: new Date() }, status: { $in: OPEN_WORK_ORDER_STATUSES } });
      const filter = { $and: filters };
      const { skip, limit } = toSkipLimit(q);
      const [docs, total] = await Promise.all([
        WorkOrder.find(filter).sort({ ...q.sort, _id: -1 }).skip(skip).limit(limit).lean(),
        WorkOrder.countDocuments(filter),
      ]);
      const items = await Promise.all((docs as unknown as WorkOrderDoc[]).map((d) => toView(p, d)));
      return { items, pagination: paginationMeta(q, total) };
    },

    async get(p: Principal, id: string) {
      const { wo } = await load(p, id);
      return toView(p, wo);
    },

    async assignStaff(p: Principal, id: string, input: { assigneeId: string; reason?: string }, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['MANAGER', 'ADMIN'], 'Only this department’s managers or administrators can assign staff.');
      if (!(await eligibleAssignee(String(wo.department), input.assigneeId))) {
        throw validationError([{ field: 'body.assigneeId', issue: 'invalid', message: 'The assignee must be an active member of the department.' }]);
      }
      const review = wo.managerReview as { reasons: string[]; requestedAt: Date } | undefined;
      const now = new Date();
      const updated = await transition(wo, 'assign_staff', { principal: p }, {
        set: {
          assignee: new Types.ObjectId(input.assigneeId),
          assignedBy: new Types.ObjectId(p.userId),
          assignedAt: now,
          ...(review && { managerReview: { ...review, decision: 'APPROVED', decidedBy: new Types.ObjectId(p.userId), decidedAt: now, decisionReason: input.reason } }),
        },
        guard: { assignee: wo.assignee ?? null }, // detects a concurrent reassignment
        reason: input.reason,
        requestId,
      });
      await events.emit('work_order.assigned', { workOrderId: String(wo._id), assigneeId: input.assigneeId }, `${wo._id}:assigned:${input.assigneeId}:${now.getTime()}`);
      return toView(p, updated);
    },

    async decline(p: Principal, id: string, reason: string, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['ASSIGNEE'], 'Only the assignee can decline this work order.');
      const updated = await transition(wo, 'decline', { principal: p }, {
        unset: ['assignee', 'acceptedAt'],
        set: { managerReview: { reasons: ['ASSIGNEE_DECLINED'], requestedAt: new Date() } },
        guard: { assignee: new Types.ObjectId(p.userId) },
        reason,
        requestId,
      });
      return toView(p, updated);
    },

    async accept(p: Principal, id: string, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['ASSIGNEE'], 'Only the assignee can accept this work order.');
      return toView(p, await transition(wo, 'accept', { principal: p }, { set: { acceptedAt: new Date() }, guard: { assignee: new Types.ObjectId(p.userId) }, requestId }));
    },

    async start(p: Principal, id: string, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['ASSIGNEE'], 'Only the assignee can start or resume this work.');
      const resume = wo.status === 'BLOCKED';
      return toView(
        p,
        await transition(wo, 'start', { principal: p }, {
          set: resume ? {} : { startedAt: new Date() },
          unset: resume ? ['blockedReason', 'blockedNextAction', 'blockedAt'] : [],
          guard: { assignee: new Types.ObjectId(p.userId) },
          reason: resume ? 'resumed' : undefined,
          requestId,
        }),
      );
    },

    async block(p: Principal, id: string, input: { reason: string; nextAction: string }, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['ASSIGNEE'], 'Only the assignee can mark this work as blocked.');
      return toView(
        p,
        await transition(wo, 'block', { principal: p }, {
          set: { blockedReason: input.reason, blockedNextAction: input.nextAction, blockedAt: new Date() },
          guard: { assignee: new Types.ObjectId(p.userId) },
          reason: input.reason,
          requestId,
        }),
      );
    },

    async addNote(p: Principal, id: string, text: string, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['ASSIGNEE', 'MANAGER', 'ADMIN'], 'Only the assignee, managers or administrators can add notes.');
      if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status)) throw new AppError('CONFLICT', 'Notes can only be added to open work orders.');
      const updated = await WorkOrder.findOneAndUpdate(
        { _id: wo._id, status: { $in: OPEN_WORK_ORDER_STATUSES } },
        { $push: { notes: { author: new Types.ObjectId(p.userId), text, at: new Date() } } },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      if (!updated) throw new AppError('CONFLICT', 'The work order was closed in the meantime.');
      await audit({ principal: p }, 'work_order.note_added', 'WorkOrder', wo._id, { requestId });
      return toView(p, updated as unknown as WorkOrderDoc);
    },

    /** Admin-only cross-department move. The new department's manager picks the assignee. */
    async transfer(p: Principal, id: string, input: { departmentId: string; reason: string }, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['ADMIN'], 'Only platform administrators can move work to another department.');
      if (String(wo.department) === input.departmentId) throw validationError([{ field: 'body.departmentId', issue: 'invalid', message: 'The work order is already in this department.' }]);
      const complaint = await Complaint.findById(wo.complaint).select('confirmedCategory selectedCategory').lean();
      const category = (complaint?.confirmedCategory ?? complaint?.selectedCategory) as Category | undefined;
      const dept = category ? await validateDepartmentFor(input.departmentId, category) : null;
      if (!dept) throw validationError([{ field: 'body.departmentId', issue: 'invalid', message: 'The complaint has no category to check the department against.' }]);
      const updated = await transition(wo, 'transfer', { principal: p }, {
        set: { department: dept._id, managerReview: { reasons: ['UNCLEAR_DEPARTMENT'], requestedAt: new Date() }, assignmentSource: 'ADMIN_OVERRIDE', assignedBy: new Types.ObjectId(p.userId), assignedAt: new Date() },
        unset: ['assignee', 'acceptedAt', 'startedAt', 'blockedReason', 'blockedNextAction', 'blockedAt'],
        reason: input.reason,
        complaintSet: { department: dept._id },
        note: `Moved to ${dept.name}.`,
        requestId,
      });
      return toView(p, updated);
    },

    /** Cancels the work order (kept as history) and sends the complaint back to triage. */
    async cancel(p: Principal, id: string, reason: string, requestId: string) {
      const { wo, roles } = await load(p, id);
      need(roles, ['MANAGER', 'ADMIN'], 'Only this department’s managers or administrators can cancel work orders.');
      const updated = await transition(wo, 'cancel', { principal: p }, {
        set: { cancelledAt: new Date(), cancelReason: reason },
        reason,
        complaintSet: { routingReview: { reasons: ['UNCLEAR_DEPARTMENT'], evaluatedAt: new Date(), policyVersion: policy.version } },
        complaintUnset: ['department'],
        requestId,
      });
      return toView(p, updated);
    },

    createWorkOrder,
    pickAssignee,
  };
}
export type WorkOrderService = ReturnType<typeof createWorkOrderService>;
