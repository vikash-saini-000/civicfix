// Map, hotspot, ward and SLA analytics for staff dashboards. Every query is scoped first:
// platform admins see the whole city; department staff see complaints and work orders of their
// departments. Citizens have no analytics access. Only aggregate counts and minimal identifiers
// (public IDs, coordinates, categories) are returned; never reporter identity.
import { Types, type PipelineStage } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import { CATEGORIES, type Category } from '../models/enums.js';
import { Complaint, Department, Place, User, Ward, WorkOrder } from '../models/index.js';
import { OPEN_WORK_ORDER_STATUSES } from '../policies/workOrderLifecycle.js';
import { AppError } from '../utils/errors.js';
import { resolveWard } from './location.js';

const OPEN_COMPLAINT = ['REPORTED', 'UNDER_REVIEW', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'];
const MONSOON_MONTHS = new Set([6, 7, 8, 9]); // June–September on the Karnataka coast
const METERS_PER_DEGREE_LAT = 111_320;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

export interface MapQuery extends AnalyticsRange {
  category?: Category;
  open?: boolean;
  departmentId?: string;
  bbox?: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  limit: number;
}

export interface HotspotQuery extends AnalyticsRange {
  category?: Category;
  departmentId?: string;
  cellMeters: number;
  minReports: number;
}

export function createAnalyticsService() {
  const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');

  /** Department scope for the caller, optionally narrowed to one department they may see. */
  function departmentScope(p: Principal, departmentId?: string): Types.ObjectId[] | null {
    if (isAdmin(p)) return departmentId ? [new Types.ObjectId(departmentId)] : null; // null = whole city
    const mine = p.memberships.map((m) => m.departmentId);
    if (mine.length === 0) throw new AppError('FORBIDDEN', 'Analytics are available to department staff and administrators.');
    if (departmentId && !mine.includes(departmentId)) throw new AppError('FORBIDDEN', 'You are not a member of that department.');
    return (departmentId ? [departmentId] : mine).map((id) => new Types.ObjectId(id));
  }

  function complaintScope(p: Principal, departmentId?: string): Record<string, unknown> {
    const depts = departmentScope(p, departmentId);
    return depts ? { department: { $in: depts } } : {};
  }

  const categoryFilter = (category?: Category) => (category ? { $or: [{ confirmedCategory: category }, { confirmedCategory: null, selectedCategory: category }] } : {});

  return {
    /** Complaint points for a live map (newest first, capped). */
    async map(p: Principal, q: MapQuery) {
      const filter: Record<string, unknown> = {
        $and: [
          complaintScope(p, q.departmentId),
          { createdAt: { $gte: q.from, $lt: q.to } },
          categoryFilter(q.category),
          q.open === undefined ? {} : q.open ? { status: { $in: OPEN_COMPLAINT } } : { status: { $nin: OPEN_COMPLAINT } },
          q.bbox
            ? { location: { $geoWithin: { $box: [[q.bbox[0], q.bbox[1]], [q.bbox[2], q.bbox[3]]] } } }
            : {},
        ],
      };
      const [docs, total] = await Promise.all([
        Complaint.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .limit(q.limit)
          .select('publicId location selectedCategory confirmedCategory priority status createdAt ward duplicateOf linkedReportCount')
          .populate('ward', 'code')
          .lean(),
        Complaint.countDocuments(filter),
      ]);
      const now = Date.now();
      const open = await WorkOrder.find({ complaint: { $in: docs.map((d) => d._id) }, status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: new Date() } }).select('complaint').lean();
      const overdue = new Set(open.map((w) => String(w.complaint)));
      return {
        total,
        truncated: total > docs.length,
        points: docs.map((d) => ({
          publicId: d.publicId,
          lat: d.location.coordinates[1],
          lng: d.location.coordinates[0],
          category: d.confirmedCategory ?? d.selectedCategory ?? null,
          priority: d.priority ?? null,
          status: d.status,
          ward: (d.ward as { code?: string } | null)?.code ?? null,
          ageDays: Math.floor((now - d.createdAt.getTime()) / 86_400_000),
          overdue: overdue.has(String(d._id)),
          duplicate: !!d.duplicateOf,
          linkedReports: d.linkedReportCount ?? 0,
        })),
      };
    },

    /**
     * Hotspots: complaints grouped into ~cellMeters grid cells per category. A cell is a hotspot when it
     * has at least minReports reports in the range. It is "recurring" when the same cell and category were
     * reported in two or more different years, or in three or more different months; "MONSOON" when those
     * reports fall in June–September of two or more years and at least 60 % of them are in those months
     * (e.g. the same road every monsoon).
     */
    async hotspots(p: Principal, q: HotspotQuery) {
      const match = { $and: [complaintScope(p, q.departmentId), { createdAt: { $gte: q.from, $lt: q.to } }, categoryFilter(q.category)] };
      const sample = await Complaint.findOne(match).select('location').lean();
      if (!sample) return { cellMeters: q.cellMeters, hotspots: [] };
      const lat0 = sample.location.coordinates[1]!;
      const dLat = q.cellMeters / METERS_PER_DEGREE_LAT;
      const dLng = q.cellMeters / (METERS_PER_DEGREE_LAT * Math.max(0.1, Math.cos((lat0 * Math.PI) / 180)));
      const pipeline: PipelineStage[] = [
        { $match: match },
        {
          $project: {
            publicId: 1,
            status: 1,
            createdAt: 1,
            lng: { $arrayElemAt: ['$location.coordinates', 0] },
            lat: { $arrayElemAt: ['$location.coordinates', 1] },
            category: { $ifNull: ['$confirmedCategory', { $ifNull: ['$selectedCategory', 'other'] }] },
          },
        },
        {
          $group: {
            _id: { x: { $floor: { $divide: ['$lng', dLng] } }, y: { $floor: { $divide: ['$lat', dLat] } }, category: '$category' },
            reports: { $sum: 1 },
            open: { $sum: { $cond: [{ $in: ['$status', OPEN_COMPLAINT] }, 1, 0] } },
            lat: { $avg: '$lat' },
            lng: { $avg: '$lng' },
            first: { $min: '$createdAt' },
            last: { $max: '$createdAt' },
            months: { $addToSet: { $dateToString: { format: '%Y-%m', date: '$createdAt' } } },
            monsoonReports: { $sum: { $cond: [{ $in: [{ $month: '$createdAt' }, [...MONSOON_MONTHS]] }, 1, 0] } },
            sample: { $push: '$publicId' },
          },
        },
        { $match: { reports: { $gte: q.minReports } } },
        { $sort: { reports: -1, last: -1 } },
        { $limit: 50 },
      ];
      const cells = await Complaint.aggregate<{ _id: { category: string }; reports: number; open: number; lat: number; lng: number; first: Date; last: Date; months: string[]; monsoonReports: number; sample: string[] }>(pipeline);
      const hotspots = [];
      for (const c of cells) {
        const point = { type: 'Point' as const, coordinates: [c.lng, c.lat] };
        const [ward, near] = await Promise.all([
          resolveWard(point),
          Place.aggregate<{ name: string; kind: string; d: number }>([
            { $geoNear: { near: { type: 'Point', coordinates: [c.lng, c.lat] }, distanceField: 'd', maxDistance: Math.max(150, q.cellMeters), spherical: true, key: 'geometry' } },
            { $limit: 1 },
          ]),
        ]);
        const months = [...c.months].sort();
        const years = new Set(months.map((m) => m.slice(0, 4)));
        const monsoonYears = new Set(months.filter((m) => MONSOON_MONTHS.has(Number(m.slice(5, 7)))).map((m) => m.slice(0, 4)));
        const recurring = years.size >= 2 || months.length >= 3;
        hotspots.push({
          category: c._id.category,
          center: { lat: round(c.lat, 5), lng: round(c.lng, 5) },
          label: near[0] ? `near ${near[0].name}` : null,
          ward: ward ? { code: ward.code, name: ward.name } : null,
          reports: c.reports,
          open: c.open,
          firstReportedAt: c.first.toISOString(),
          lastReportedAt: c.last.toISOString(),
          recurring,
          // MONSOON: reported in the monsoon months of two or more years, and mostly then (≥ 60 %).
          pattern: monsoonYears.size >= 2 && c.monsoonReports / c.reports >= 0.6 ? 'MONSOON' : recurring ? (years.size >= 2 ? 'YEAR_ON_YEAR' : 'REPEATED') : null,
          monthsWithReports: months,
          samplePublicIds: c.sample.slice(-5),
        });
      }
      return { cellMeters: q.cellMeters, hotspots };
    },

    /** Per-ward counts within the caller's scope. */
    async wards(p: Principal, range: AnalyticsRange, departmentId?: string) {
      const scope = complaintScope(p, departmentId);
      const rows = await Complaint.aggregate<{ _id: Types.ObjectId | null; total: number; open: number; resolved: number; avgMs: number | null; categories: string[] }>([
        { $match: { ...scope, createdAt: { $gte: range.from, $lt: range.to } } },
        {
          $group: {
            _id: '$ward',
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $in: ['$status', OPEN_COMPLAINT] }, 1, 0] } },
            resolved: { $sum: { $cond: [{ $in: ['$status', ['RESOLVED', 'CLOSED']] }, 1, 0] } },
            avgMs: { $avg: { $cond: [{ $ifNull: ['$resolvedAt', false] }, { $subtract: ['$resolvedAt', '$createdAt'] }, null] } },
            categories: { $push: { $ifNull: ['$confirmedCategory', { $ifNull: ['$selectedCategory', 'other'] }] } },
          },
        },
      ]);
      const overdueRows = await WorkOrder.aggregate<{ _id: Types.ObjectId | null; n: number }>([
        { $match: { status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: new Date() }, ...(scope.department ? { department: scope.department } : {}) } },
        { $lookup: { from: 'complaints', localField: 'complaint', foreignField: '_id', as: 'c', pipeline: [{ $project: { ward: 1 } }] } },
        { $group: { _id: { $first: '$c.ward' }, n: { $sum: 1 } } },
      ]);
      const overdue = new Map(overdueRows.map((r) => [String(r._id), r.n]));
      const wards = await Ward.find({}).select('code name population').sort({ code: 1 }).lean();
      const byId = new Map(rows.map((r) => [String(r._id), r]));
      const view = (r: (typeof rows)[number] | undefined, key: string) => {
        const counts: Record<string, number> = {};
        for (const c of r?.categories ?? []) counts[c] = (counts[c] ?? 0) + 1;
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return {
          total: r?.total ?? 0,
          open: r?.open ?? 0,
          resolved: r?.resolved ?? 0,
          overdueWorkOrders: overdue.get(key) ?? 0,
          averageHoursToResolve: r?.avgMs == null ? null : round(r.avgMs / 3_600_000),
          topCategory: top ? top[0] : null,
          byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, counts[c] ?? 0])),
        };
      };
      return {
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        wards: wards.map((w) => ({
          code: w.code,
          name: w.name,
          population: w.population ?? null,
          ...view(byId.get(String(w._id)), String(w._id)),
          reportsPer10k: w.population ? round(((byId.get(String(w._id))?.total ?? 0) / w.population) * 10_000, 2) : null,
        })),
        outsideWards: view(byId.get('null'), 'null'),
      };
    },

    /** SLA compliance per department, and the most overdue open work orders. */
    async sla(p: Principal, range: AnalyticsRange, departmentId?: string) {
      const depts = departmentScope(p, departmentId);
      const deptMatch = depts ? { department: { $in: depts } } : {};
      const now = new Date();
      const [perDept, overdueList] = await Promise.all([
        WorkOrder.aggregate<{ _id: Types.ObjectId; open: number; overdue: number; breachedInRange: number; completedInRange: number; completedOnTime: number; avgAssignMs: number | null }>([
          { $match: deptMatch },
          {
            $group: {
              _id: '$department',
              open: { $sum: { $cond: [{ $in: ['$status', OPEN_WORK_ORDER_STATUSES] }, 1, 0] } },
              overdue: { $sum: { $cond: [{ $and: [{ $in: ['$status', OPEN_WORK_ORDER_STATUSES] }, { $lt: ['$dueAt', now] }] }, 1, 0] } },
              breachedInRange: { $sum: { $cond: [{ $and: [{ $gte: ['$slaBreachedAt', range.from] }, { $lt: ['$slaBreachedAt', range.to] }] }, 1, 0] } },
              completedInRange: { $sum: { $cond: [{ $and: [{ $gte: ['$completedAt', range.from] }, { $lt: ['$completedAt', range.to] }] }, 1, 0] } },
              completedOnTime: {
                $sum: { $cond: [{ $and: [{ $gte: ['$completedAt', range.from] }, { $lt: ['$completedAt', range.to] }, { $lte: ['$completedAt', '$dueAt'] }] }, 1, 0] },
              },
              avgAssignMs: { $avg: { $cond: [{ $and: [{ $gte: ['$createdAt', range.from] }, { $lt: ['$createdAt', range.to] }] }, { $subtract: ['$assignedAt', '$createdAt'] }, null] } },
            },
          },
        ]),
        WorkOrder.find({ ...deptMatch, status: { $in: OPEN_WORK_ORDER_STATUSES }, dueAt: { $lt: now } })
          .sort({ dueAt: 1 })
          .limit(20)
          .select('publicId priority status dueAt department assignee complaint')
          .populate('department', 'name')
          .populate('complaint', 'publicId')
          .lean(),
      ]);
      const names = new Map((await Department.find({ _id: { $in: perDept.map((d) => d._id) } }).select('name').lean()).map((d) => [String(d._id), d.name]));
      const assignees = new Map(
        (await User.find({ _id: { $in: overdueList.map((w) => w.assignee).filter(Boolean) } }).select('name').lean()).map((u) => [String(u._id), u.name]),
      );
      return {
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        departments: perDept
          .map((d) => ({
            department: { id: String(d._id), name: names.get(String(d._id)) ?? null },
            openWorkOrders: d.open,
            overdueNow: d.overdue,
            breachedInRange: d.breachedInRange,
            completedInRange: d.completedInRange,
            onTimeRate: d.completedInRange ? round(d.completedOnTime / d.completedInRange, 3) : null,
          }))
          .sort((a, b) => b.overdueNow - a.overdueNow),
        mostOverdue: overdueList.map((w) => ({
          publicId: w.publicId,
          complaintPublicId: (w.complaint as { publicId?: string } | null)?.publicId ?? null,
          priority: w.priority,
          status: w.status,
          department: (w.department as { name?: string } | null)?.name ?? null,
          assignee: w.assignee ? (assignees.get(String(w.assignee)) ?? null) : null,
          dueAt: w.dueAt!.toISOString(),
          hoursOverdue: round((now.getTime() - w.dueAt!.getTime()) / 3_600_000),
        })),
      };
    },

    /**
     * How much of the workflow runs automatically, in the caller's scope: share of work orders created by
     * the rules (vs a human), median minutes from submission to work order, duplicates linked, spam flags,
     * and why cases went to human review.
     */
    async overview(p: Principal, range: AnalyticsRange, departmentId?: string) {
      const depts = departmentScope(p, departmentId);
      const deptMatch = depts ? { department: { $in: depts } } : {};
      const inRange = { createdAt: { $gte: range.from, $lt: range.to } };
      const [sources, toWorkOrder, complaints, reasons] = await Promise.all([
        WorkOrder.aggregate<{ _id: string; n: number }>([{ $match: { ...deptMatch, ...inRange } }, { $group: { _id: '$assignmentSource', n: { $sum: 1 } } }]),
        WorkOrder.aggregate<{ minutes: number }>([
          { $match: { ...deptMatch, ...inRange } },
          { $lookup: { from: 'complaints', localField: 'complaint', foreignField: '_id', as: 'c', pipeline: [{ $project: { createdAt: 1 } }] } },
          { $project: { minutes: { $divide: [{ $subtract: ['$createdAt', { $first: '$c.createdAt' }] }, 60_000] } } },
          { $sort: { minutes: 1 } },
        ]),
        Complaint.aggregate<{ _id: null; total: number; duplicates: number; spamFlagged: number; followUpAsked: number; followUpAnswered: number }>([
          { $match: { ...(depts ? { department: { $in: depts } } : {}), ...inRange } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              duplicates: { $sum: { $cond: [{ $ifNull: ['$duplicateOf', false] }, 1, 0] } },
              spamFlagged: { $sum: { $cond: [{ $gte: ['$spamCheck.score', 0.6] }, 1, 0] } },
              followUpAsked: { $sum: { $cond: [{ $ifNull: ['$followUp', false] }, 1, 0] } },
              followUpAnswered: { $sum: { $cond: [{ $ifNull: ['$followUp.answeredAt', false] }, 1, 0] } },
            },
          },
        ]),
        Complaint.aggregate<{ _id: string; n: number }>([
          { $match: { ...(depts ? { $or: [{ department: { $in: depts } }, { 'routingReview.suggestedDepartment': { $in: depts } }] } : {}), ...inRange, 'routingReview.reasons.0': { $exists: true } } },
          { $unwind: '$routingReview.reasons' },
          { $group: { _id: '$routingReview.reasons', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ]),
      ]);
      const bySource = Object.fromEntries(sources.map((s) => [s._id ?? 'UNKNOWN', s.n]));
      const totalWo = sources.reduce((s, x) => s + x.n, 0);
      const mins = toWorkOrder.map((r) => r.minutes).filter((m) => Number.isFinite(m) && m >= 0);
      const median = mins.length ? mins[Math.floor(mins.length / 2)]! : null;
      const c = complaints[0];
      return {
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        workOrders: { total: totalWo, bySource, automatedShare: totalWo ? round((bySource.AUTO ?? 0) / totalWo, 3) : null },
        medianMinutesToWorkOrder: median == null ? null : round(median),
        complaints: {
          total: c?.total ?? 0,
          linkedAsDuplicates: c?.duplicates ?? 0,
          spamFlagged: c?.spamFlagged ?? 0,
          followUpAsked: c?.followUpAsked ?? 0,
          followUpAnswered: c?.followUpAnswered ?? 0,
        },
        // Current open review cases only (routing review is cleared once a case is assigned).
        reviewReasons: Object.fromEntries(reasons.map((r) => [r._id, r.n])),
      };
    },
  };
}
export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
