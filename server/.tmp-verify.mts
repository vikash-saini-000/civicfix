import mongoose, { Types } from 'mongoose';
import './src/models/index.ts';
import { Complaint, WorkOrder, Ward } from './src/models/index.ts';
import { COMPLAINT_STATUS_FOR_WORK_ORDER } from './src/policies/complaintLifecycle.ts';
import { createAnalyticsService } from './src/services/analytics.ts';
const uri = process.env.URI!;
await mongoose.connect(uri);
const byStatus = await Complaint.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
console.log('statuses', JSON.stringify(Object.fromEntries(byStatus.map((r) => [r._id, r.n]))));
let bad = 0;
const now = Date.now();
for (const wo of await WorkOrder.find().lean()) {
  const c = await Complaint.findById(wo.complaint).lean();
  const expected = wo.status === 'COMPLETED' ? ['RESOLVED', 'CLOSED'] : [COMPLAINT_STATUS_FOR_WORK_ORDER[wo.status]];
  if (!expected.includes(c!.status)) { bad++; console.log('mismatch', wo.publicId, wo.status, c!.status); }
}
for (const c of await Complaint.find().lean()) {
  if (c.statusHistory.some((h) => h.at.getTime() > now) ) { bad++; console.log('future', c.publicId); }
  const sorted = c.statusHistory.every((h, i, a) => i === 0 || a[i - 1]!.at <= h.at);
  if (!sorted) { bad++; console.log('unsorted', c.publicId, c.statusHistory.map((h) => h.status).join('>')); }
  if (c.statusHistory.at(-1)!.status !== c.status) { bad++; console.log('last!=status', c.publicId); }
}
console.log('consistency problems:', bad);
const admin = { userId: new Types.ObjectId().toString(), roles: new Set(['PLATFORM_ADMIN']), memberships: [] } as never;
const a = createAnalyticsService();
const range = { from: new Date('2025-01-01'), to: new Date() };
const hs = await a.hotspots(admin, { ...range, cellMeters: 250, minReports: 3 });
for (const h of hs.hotspots) console.log('hotspot', h.category, h.reports, h.open, h.recurring, h.pattern, h.label, h.ward?.name);
const w = await a.wards(admin, { from: new Date(Date.now() - 365 * 864e5), to: new Date() });
console.log('wards', w.wards.map((x) => `${x.code}:${x.total}/${x.open}open/${x.overdueWorkOrders}od`).join(' '), 'outside', w.outsideWards.total);
const s = await a.sla(admin, { from: new Date(Date.now() - 365 * 864e5), to: new Date() });
console.log('sla', s.departments.map((d) => `${d.department.name}: open ${d.openWorkOrders}, overdue ${d.overdueNow}, onTime ${d.onTimeRate}`).join(' | '));
console.log('mostOverdue', s.mostOverdue.slice(0, 3).map((x) => `${x.publicId} ${x.priority} ${x.hoursOverdue}h`).join(', '));
const o = await a.overview(admin, { from: new Date(Date.now() - 365 * 864e5), to: new Date() });
console.log('overview', JSON.stringify(o.workOrders), 'medianMin', o.medianMinutesToWorkOrder, JSON.stringify(o.complaints), JSON.stringify(o.reviewReasons));
const m = await a.map(admin, { ...range, limit: 5 });
console.log('map total', m.total, 'sample', JSON.stringify(m.points[0]));
await mongoose.disconnect();
