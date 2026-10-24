// Dashboard metrics. Every query is scoped (owner / department / platform) before aggregating, uses
// MongoDB aggregation, and returns only counts and minimal identifiers.
import { Types, type Model, type PipelineStage } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import { COMPLAINT_STATUSES, WORK_ORDER_STATUSES } from '../models/enums.js';
import { AIAnalysis, Complaint, Department, DepartmentMembership, Dispute, Notification, User, WorkOrder } from '../models/index.js';
import { OPEN_WORK_ORDER_STATUSES } from '../policies/workOrderLifecycle.js';
import { AppError, notFoundError, validationError } from '../utils/errors.js';

/** Statuses counted as "active": not resolved, closed or rejected. */
export const ACTIVE_COMPLAINT_STATUSES = ['REPORTED', 'UNDER_REVIEW', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'];
export const RESOLVED_COMPLAINT_STATUSES = ['RESOLVED', 'CLOSED'];
const PENDING_VERIFICATION = ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'];

export interface DateRange {
  from: Date;
  to: Date;
}

/** Zero-filled counts so the frontend always gets every key. */
function countsBy(keys: readonly string[], rows: { _id: string | null; n: number }[]) {
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) if (r._id && r._id in out) out[r._id] = r.n;
  return out;
}

/** Count of documents per value of `field`, within an already-scoped match. */
function groupCount(model: Model<any>, match: Record<string, unknown>, field: string): Promise<{ _id: string | null; n: number }[]> {
  const pipeline: PipelineStage[] = [{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }];
  return model.aggregate(pipeline).exec();
}

const rangeView = (r: DateRange) => ({ from: r.from.toISOString(), to: r.to.toISOString() });
const hours = (ms: number | null | undefined) => (ms == null ? null : Math.round((ms / 3_600_000) * 10) / 10);

async function resolutionStats(match: Record<string, unknown>, range: DateRange) {
  const [row] = await Complaint.aggregate<{ n: number; avg: number }>([
    { $match: { ...match, resolvedAt: { $gte: range.from, $lt: range.to } } },
    { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } } } },
  ]);
  return { resolvedInRange: row?.n ?? 0, averageHoursToResolve: hours(row?.avg) };
}

export function createDashboardService() {
  const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');

  /** The department a member dashboard is about: the requested one (must be theirs) or their only one. */
  async function memberDepartment(p: Principal, departmentId?: string, needManager = false) {
    const mine = p.memberships.filter((m) => !needManager || m.role === 'MANAGER');
    let id = departmentId;
    if (!id) {
      if (mine.length === 1) id = mine[0]!.departmentId;
      else if (mine.length === 0 && !isAdmin(p)) throw new AppError('FORBIDDEN', needManager ? 'You are not a manager of any department.' : 'You are not an active member of any department.');
      else throw validationError([{ field: 'query.departmentId', issue: 'required', message: 'Choose a department.' }]);
    }
    if (!mine.some((m) => m.departmentId === id) && !(needManager && isAdmin(p))) {
      throw new AppError('FORBIDDEN', needManager ? 'You do not manage that department.' : 'You are not a member of that department.');
    }
    const dept = await Department.findById(id).select('name isActive').lean();
    if (!dept) throw notFoundError('The department');
    return dept;
  }

  return {
    async citizen(p: Principal, range: DateRange) {
      const me = new Types.ObjectId(p.userId);
      const match = { citizen: me };
      const [byStatusRows, createdInRange, recent, openDisputes, unread] = await Promise.all([
        groupCount(Complaint, match, 'status'),
        Complaint.countDocuments({ ...match, createdAt: { $gte: range.from, $lt: range.to } }),
        Complaint.find(match).sort({ updatedAt: -1, _id: -1 }).limit(5).select('publicId title status updatedAt').lean(),
        Dispute.countDocuments({ submittedBy: me, status: { $in: ['OPEN', 'UNDER_REVIEW'] } }),
        Notification.countDocuments({ recipient: me, readAt: null }),
      ]);
      const byStatus = countsBy(COMPLAINT_STATUSES, byStatusRows);
      const sum = (keys: string[]) => keys.reduce((s, k) => s + (byStatus[k] ?? 0), 0);
      return {
        range: rangeView(range),
        complaints: {
          total: sum([...COMPLAINT_STATUSES]),
          active: sum(ACTIVE_COMPLAINT_STATUSES),
          resolved: sum(RESOLVED_COMPLAINT_STATUSES),
          rejected: byStatus.REJECTED ?? 0,
          byStatus,
          createdInRange,
        },
        recent: recent.map((c) => ({ publicId: c.publicId, title: c.title, status: c.status, updatedAt: c.updatedAt!.toISOString() })),
        openDisputes,
        unreadNotifications: unread,
      };
    },

    async member(p: Principal, departmentId: string | undefined) {
      const dept = await memberDepartment(p, departmentId);
      const deptId = dept._id;
      const me = new Types.ObjectId(p.userId);
      const now = new Date();
      const [complaintRows, myRows, myOverdue, deptOpen, recent] = await Promise.all([
        groupCount(Complaint, { department: deptId }, 'status'),
        groupCount(WorkOrder, { department: deptId, assignee: me }, 'status'),
        WorkOrder.countDocuments({ department: deptId, assignee: me, status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: now } }),
        WorkOrder.countDocuments({ department: deptId, status: { $in: OPEN_WORK_ORDER_STATUSES } }),
        WorkOrder.find({ department: deptId }).sort({ updatedAt: -1, _id: -1 }).limit(10).select('publicId status priority dueAt updatedAt').lean(),
      ]);
      const mine = countsBy(WORK_ORDER_STATUSES, myRows);
      return {
        department: { id: String(deptId), name: dept.name },
        complaintsByStatus: countsBy(COMPLAINT_STATUSES, complaintRows),
        myWork: {
          byStatus: mine,
          open: OPEN_WORK_ORDER_STATUSES.reduce((s, k) => s + (mine[k] ?? 0), 0),
          awaitingAcceptance: mine.ASSIGNED ?? 0,
          inProgress: mine.IN_PROGRESS ?? 0,
          blocked: mine.BLOCKED ?? 0,
          awaitingVerification: (mine.RESOLUTION_SUBMITTED ?? 0) + (mine.VERIFICATION_REQUIRED ?? 0),
          overdue: myOverdue,
        },
        departmentOpenWorkOrders: deptOpen,
        recentActivity: recent.map((w) => ({ publicId: w.publicId, status: w.status, priority: w.priority, overdue: !!w.dueAt && w.dueAt < now && OPEN_WORK_ORDER_STATUSES.includes(w.status), updatedAt: w.updatedAt!.toISOString() })),
      };
    },

    async manager(p: Principal, departmentId: string | undefined, range: DateRange) {
      const dept = await memberDepartment(p, departmentId, true);
      const deptId = dept._id;
      const now = new Date();
      const [cStatus, cCategory, createdInRange, woStatus, overdue, workloadRows, members, openDisputes, routingQueue, resolution] = await Promise.all([
        groupCount(Complaint, { department: deptId }, 'status'),
        Complaint.aggregate<{ _id: string | null; n: number }>([{ $match: { department: deptId } }, { $group: { _id: { $ifNull: ['$confirmedCategory', '$selectedCategory'] }, n: { $sum: 1 } } }]),
        Complaint.countDocuments({ department: deptId, createdAt: { $gte: range.from, $lt: range.to } }),
        groupCount(WorkOrder, { department: deptId }, 'status'),
        WorkOrder.countDocuments({ department: deptId, status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: now } }),
        WorkOrder.aggregate<{ _id: Types.ObjectId; open: number; overdue: number }>([
          { $match: { department: deptId, status: { $in: OPEN_WORK_ORDER_STATUSES }, assignee: { $exists: true } } },
          { $group: { _id: '$assignee', open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$dueAt', now] }, 1, 0] } } } },
        ]),
        DepartmentMembership.find({ department: deptId, status: 'ACTIVE' }).select('user role').limit(500).lean(),
        Dispute.countDocuments({ workOrder: { $in: (await WorkOrder.find({ department: deptId }).select('_id').limit(5000).lean()).map((w) => w._id) }, status: { $in: ['OPEN', 'UNDER_REVIEW'] } }),
        Complaint.countDocuments({ department: deptId, status: { $in: ['REPORTED', 'UNDER_REVIEW'] } }),
        resolutionStats({ department: deptId }, range),
      ]);
      const users = await User.find({ _id: { $in: members.map((m) => m.user) } }).select('name').lean();
      const load = new Map(workloadRows.map((r) => [String(r._id), r]));
      const wo = countsBy(WORK_ORDER_STATUSES, woStatus);
      return {
        department: { id: String(deptId), name: dept.name, isActive: dept.isActive },
        range: rangeView(range),
        complaints: { byStatus: countsBy(COMPLAINT_STATUSES, cStatus), byCategory: Object.fromEntries(cCategory.filter((r) => r._id).map((r) => [r._id!, r.n])), createdInRange, awaitingRouting: routingQueue },
        workOrders: {
          byStatus: wo,
          open: OPEN_WORK_ORDER_STATUSES.reduce((s, k) => s + (wo[k] ?? 0), 0),
          unassigned: wo.PENDING_ASSIGNMENT ?? 0,
          awaitingAcceptance: wo.ASSIGNED ?? 0,
          blocked: wo.BLOCKED ?? 0,
          overdue,
          pendingVerification: PENDING_VERIFICATION.reduce((s, k) => s + (wo[k] ?? 0), 0),
        },
        workload: members
          .map((m) => {
            const l = load.get(String(m.user));
            return { member: { id: String(m.user), name: users.find((u) => String(u._id) === String(m.user))?.name ?? null }, role: m.role, openWorkOrders: l?.open ?? 0, overdue: l?.overdue ?? 0 };
          })
          .sort((a, b) => b.openWorkOrders - a.openWorkOrders || (a.member.name ?? '').localeCompare(b.member.name ?? '')),
        openDisputes,
        resolution,
      };
    },

    async admin(p: Principal, range: DateRange) {
      if (!isAdmin(p)) throw new AppError('FORBIDDEN', 'Only platform administrators can see platform metrics.');
      const now = new Date();
      const [cStatus, cCategory, createdInRange, intake, unrouted, woStatus, overdue, bySource, autoInRange, deptRows, depts, openDisputes, triage, resolution] = await Promise.all([
        groupCount(Complaint, {}, 'status'),
        Complaint.aggregate<{ _id: string | null; n: number }>([{ $group: { _id: { $ifNull: ['$confirmedCategory', '$selectedCategory'] }, n: { $sum: 1 } } }]),
        Complaint.countDocuments({ createdAt: { $gte: range.from, $lt: range.to } }),
        Complaint.aggregate<{ _id: string; n: number }>([
          { $match: { createdAt: { $gte: range.from, $lt: range.to } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
        Complaint.countDocuments({ status: { $in: ['REPORTED', 'UNDER_REVIEW'] }, department: null }),
        groupCount(WorkOrder, {}, 'status'),
        WorkOrder.countDocuments({ status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: now } }),
        groupCount(WorkOrder, {}, 'assignmentSource'),
        WorkOrder.countDocuments({ assignmentSource: 'AUTO', createdAt: { $gte: range.from, $lt: range.to } }),
        WorkOrder.aggregate<{ _id: Types.ObjectId; open: number; overdue: number }>([
          { $match: { status: { $in: OPEN_WORK_ORDER_STATUSES } } },
          { $group: { _id: '$department', open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$dueAt', now] }, 1, 0] } } } },
        ]),
        Department.find().select('name isActive').sort({ name: 1 }).limit(200).lean(),
        Dispute.countDocuments({ status: { $in: ['OPEN', 'UNDER_REVIEW'] } }),
        AIAnalysis.aggregate<{ _id: string; n: number }>([
          { $match: { analysisType: 'TRIAGE', createdAt: { $gte: range.from, $lt: range.to } } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ]),
        resolutionStats({}, range),
      ]);
      const wo = countsBy(WORK_ORDER_STATUSES, woStatus);
      const perDept = new Map(deptRows.map((r) => [String(r._id), r]));
      return {
        range: rangeView(range),
        complaints: {
          byStatus: countsBy(COMPLAINT_STATUSES, cStatus),
          byCategory: Object.fromEntries(cCategory.filter((r) => r._id).map((r) => [r._id!, r.n])),
          createdInRange,
          intakeByDay: intake.map((d) => ({ date: d._id, count: d.n })),
          awaitingRouting: unrouted,
        },
        workOrders: {
          byStatus: wo,
          open: OPEN_WORK_ORDER_STATUSES.reduce((s, k) => s + (wo[k] ?? 0), 0),
          overdue,
          pendingVerification: PENDING_VERIFICATION.reduce((s, k) => s + (wo[k] ?? 0), 0),
          bySource: Object.fromEntries(bySource.filter((r) => r._id).map((r) => [r._id!, r.n])),
        },
        departments: depts.map((d) => ({ id: String(d._id), name: d.name, isActive: d.isActive, openWorkOrders: perDept.get(String(d._id))?.open ?? 0, overdue: perDept.get(String(d._id))?.overdue ?? 0 })),
        disputes: { open: openDisputes },
        resolution,
        ai: {
          classificationsInRange: countsBy(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INVALID_OUTPUT'], triage),
          autoAssignedInRange: autoInRange,
        },
      };
    },
  };
}
export type DashboardService = ReturnType<typeof createDashboardService>;
