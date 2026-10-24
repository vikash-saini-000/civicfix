// Who in a department can take more work. Shared by automatic assignment and the triage agent's
// read-only staff tool, so both see exactly the same eligibility rules.
import type { Types } from 'mongoose';
import { DepartmentMembership, User, WorkOrder } from '../models/index.js';
import { OPEN_WORK_ORDER_STATUSES } from '../policies/workOrderLifecycle.js';

/** Default cap on open work orders per member (assignment policy, needs product-owner sign-off). */
export const DEFAULT_MAX_OPEN_PER_MEMBER = 10;

export interface AvailableMember {
  user: Types.ObjectId;
  openWorkOrders: number;
}

/**
 * Active, on-duty MEMBERs (not managers) with an active account and fewer than `maxOpen` open work orders,
 * sorted by fewest open work first, then longest-standing membership.
 */
export async function availableMembers(departmentId: Types.ObjectId | string, maxOpen: number): Promise<AvailableMember[]> {
  const memberships = await DepartmentMembership.find({ department: departmentId, status: 'ACTIVE', role: 'MEMBER', onDuty: { $ne: false } }).sort({ createdAt: 1, _id: 1 }).select('user').limit(200).lean();
  if (memberships.length === 0) return [];
  const users = memberships.map((m) => m.user);
  const active = new Set((await User.find({ _id: { $in: users }, accountStatus: 'ACTIVE' }).select('_id').lean()).map((u) => String(u._id)));
  const loads = await WorkOrder.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { assignee: { $in: users }, status: { $in: OPEN_WORK_ORDER_STATUSES } } },
    { $group: { _id: '$assignee', n: { $sum: 1 } } },
  ]);
  const load = new Map(loads.map((l) => [String(l._id), l.n]));
  return memberships
    .map((m, order) => ({ user: m.user, openWorkOrders: load.get(String(m.user)) ?? 0, order }))
    .filter((m) => active.has(String(m.user)) && m.openWorkOrders < maxOpen)
    .sort((a, b) => a.openWorkOrders - b.openWorkOrders || a.order - b.order)
    .map(({ user, openWorkOrders }) => ({ user, openWorkOrders }));
}
