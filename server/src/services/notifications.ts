// In-app notifications built from domain events. Recipient selection lives here and nowhere else.
// Each notification has a dedupe key (event key + recipient), so a re-emitted event never notifies
// anyone twice. Handlers run after the business change is stored; a failure here is logged by the
// event bus and never undoes the change.
import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { EventBus } from '../events/bus.js';
import type { NotificationType } from '../models/enums.js';
import { Complaint, DepartmentMembership, Dispute, Notification, User, WorkOrder } from '../models/index.js';
import { notFoundError } from '../utils/errors.js';
import { paginationMeta, toSkipLimit, type PaginationQuery } from '../validation/pagination.js';

const STATUS_LABEL: Record<string, string> = {
  REPORTED: 'received',
  UNDER_REVIEW: 'under review',
  ASSIGNED: 'assigned to a team',
  ACCEPTED: 'accepted by the team',
  IN_PROGRESS: 'in progress',
  BLOCKED: 'on hold',
  RESOLUTION_SUBMITTED: 'marked as fixed and being checked',
  VERIFICATION_REQUIRED: 'waiting for a manager to check the fix',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
  REJECTED: 'rejected',
};

type Draft = {
  recipient: Types.ObjectId | string;
  type: NotificationType;
  title: string;
  message: string;
  complaint?: Types.ObjectId | string;
  workOrder?: Types.ObjectId | string;
  dispute?: Types.ObjectId | string;
};

export function createNotificationService() {
  /** Active users only; drops duplicates in the recipient list. */
  async function activeOnly(ids: (Types.ObjectId | string)[]) {
    const unique = [...new Set(ids.map(String))];
    if (unique.length === 0) return [];
    const users = await User.find({ _id: { $in: unique }, accountStatus: 'ACTIVE' }).select('_id').lean();
    return users.map((u) => u._id);
  }

  async function managersOf(departmentId: Types.ObjectId | string | null | undefined) {
    if (!departmentId) return [];
    const rows = await DepartmentMembership.find({ department: departmentId, role: 'MANAGER', status: 'ACTIVE' }).select('user').lean();
    return rows.map((r) => r.user);
  }

  async function admins() {
    const rows = await User.find({ platformRole: 'PLATFORM_ADMIN', accountStatus: 'ACTIVE' }).select('_id').limit(50).lean();
    return rows.map((r) => r._id);
  }

  /** Inserts one notification per recipient; duplicates (same event + recipient) are ignored. */
  async function deliver(eventKey: string, recipients: (Types.ObjectId | string)[], draft: Omit<Draft, 'recipient'>) {
    const ids = await activeOnly(recipients);
    if (ids.length === 0) return;
    const now = new Date();
    const docs = ids.map((recipient) => ({
      ...draft,
      recipient,
      channel: 'IN_APP' as const,
      deliveryStatus: 'SENT' as const,
      deliveredAt: now,
      dedupeKey: `${eventKey}|${String(recipient)}`.slice(0, 200),
    }));
    try {
      await Notification.insertMany(docs, { ordered: false });
    } catch (err) {
      // Duplicate keys mean "already notified"; anything else is a real failure.
      const writeErrors = (err as { writeErrors?: { code?: number; err?: { code?: number } }[] }).writeErrors;
      if (!writeErrors || writeErrors.some((w) => (w.code ?? w.err?.code) !== 11000)) throw err;
    }
  }

  return {
    /** Subscribes to every business event that should notify someone. */
    register(events: EventBus) {
      events.on('complaint.created', async ({ complaintId }, { eventId }) => {
        const c = await Complaint.findById(complaintId).select('citizen publicId').lean();
        if (!c) return;
        await deliver(eventId, [c.citizen], { type: 'COMPLAINT_RECEIVED', title: `We received ${c.publicId}`, message: 'Thank you. We will keep you updated as it moves along.', complaint: c._id });
      });

      events.on('complaint.status_changed', async ({ complaintId, to, note }, { eventId }) => {
        const c = await Complaint.findById(complaintId).select('citizen publicId').lean();
        if (!c) return;
        // Only the citizen-facing note, never internal work notes.
        await deliver(eventId, [c.citizen], { type: 'COMPLAINT_STATUS_CHANGED', title: `${c.publicId} is ${STATUS_LABEL[to] ?? to.toLowerCase()}`, message: (note ?? '').slice(0, 1000) || `Your complaint is now ${STATUS_LABEL[to] ?? to}.`, complaint: c._id });
      });

      events.on('assignment.review_required', async ({ complaintId, departmentId, reasons }, { eventId }) => {
        const c = await Complaint.findById(complaintId).select('publicId title').lean();
        if (!c) return;
        const recipients = departmentId ? await managersOf(departmentId) : await admins();
        await deliver(eventId, recipients, {
          type: 'MANAGER_REVIEW_REQUIRED',
          title: `${c.publicId} needs an assignment decision`,
          message: `${c.title}${reasons.length ? ` (${reasons.join(', ').toLowerCase().replace(/_/g, ' ')})` : ''}`.slice(0, 1000),
          complaint: c._id,
        });
      });

      events.on('work_order.created', async ({ workOrderId }, { eventId }) => {
        const wo = await WorkOrder.findById(workOrderId).select('publicId department assignee complaint').lean();
        if (!wo || wo.assignee) return; // the assignee gets work_order.assigned instead
        await deliver(eventId, await managersOf(wo.department), { type: 'MANAGER_REVIEW_REQUIRED', title: `${wo.publicId} needs a team member`, message: 'Please assign a team member to this work order.', workOrder: wo._id, complaint: wo.complaint });
      });

      events.on('work_order.assigned', async ({ workOrderId, assigneeId }, { eventId }) => {
        const wo = await WorkOrder.findById(workOrderId).select('publicId priority complaint dueAt').lean();
        if (!wo) return;
        await deliver(eventId, [assigneeId], { type: 'WORK_ORDER_ASSIGNED', title: `New work: ${wo.publicId} (${wo.priority})`, message: `Due ${wo.dueAt?.toISOString().slice(0, 10) ?? 'soon'}. Please accept or decline.`, workOrder: wo._id, complaint: wo.complaint });
      });

      events.on('work_order.status_changed', async ({ workOrderId, to }, { eventId }) => {
        if (to !== 'PENDING_ASSIGNMENT' && to !== 'BLOCKED') return; // only changes a manager must act on
        const wo = await WorkOrder.findById(workOrderId).select('publicId department complaint').lean();
        if (!wo) return;
        const title = to === 'BLOCKED' ? `${wo.publicId} is blocked` : `${wo.publicId} needs a new assignee`;
        await deliver(eventId, await managersOf(wo.department), { type: 'WORK_ORDER_UPDATED', title, message: 'Open the work order for details.', workOrder: wo._id, complaint: wo.complaint });
      });

      events.on('resolution.submitted', async ({ workOrderId }, { eventId }) => {
        const wo = await WorkOrder.findById(workOrderId).select('publicId department complaint assignee').lean();
        if (!wo) return;
        const recipients = (await managersOf(wo.department)).filter((m) => String(m) !== String(wo.assignee));
        await deliver(eventId, recipients, { type: 'VERIFICATION_NEEDED', title: `${wo.publicId}: fix submitted`, message: 'Please review the evidence and record a decision.', workOrder: wo._id, complaint: wo.complaint });
      });

      events.on('resolution.decided', async ({ workOrderId, decision }, { eventId }) => {
        const wo = await WorkOrder.findById(workOrderId).select('publicId assignee complaint').lean();
        if (!wo?.assignee) return;
        const text: Record<string, string> = { APPROVED: 'was approved', REJECTED: 'was not accepted; please continue the work', MORE_EVIDENCE_REQUESTED: 'needs more evidence' };
        await deliver(eventId, [wo.assignee], { type: 'WORK_ORDER_UPDATED', title: `${wo.publicId}: your fix ${text[decision] ?? 'was reviewed'}`, message: 'Open the work order to see the reviewer’s reason.', workOrder: wo._id, complaint: wo.complaint });
      });

      events.on('dispute.created', async ({ disputeId, complaintId }, { eventId }) => {
        const c = await Complaint.findById(complaintId).select('publicId department').lean();
        if (!c) return;
        await deliver(eventId, await managersOf(c.department), { type: 'DISPUTE_SUBMITTED', title: `${c.publicId}: the citizen disputes the fix`, message: 'Please review the dispute.', dispute: disputeId, complaint: c._id });
      });

      events.on('dispute.decided', async ({ disputeId, decision }, { eventId }) => {
        const d = await Dispute.findById(disputeId).select('submittedBy complaint').lean();
        if (!d) return;
        const c = await Complaint.findById(d.complaint).select('publicId').lean();
        const message = decision === 'UPHELD' ? 'You were right: the work has been reopened.' : 'After review, the fix was confirmed. The reason is on your complaint.';
        await deliver(eventId, [d.submittedBy], { type: 'DISPUTE_DECIDED', title: `${c?.publicId ?? 'Your complaint'}: dispute ${decision === 'UPHELD' ? 'upheld' : 'not upheld'}`, message, dispute: d._id, complaint: d.complaint });
      });
    },

    async list(p: Principal, q: PaginationQuery & { unread?: boolean }) {
      const filter: Record<string, unknown> = { recipient: new Types.ObjectId(p.userId) };
      if (q.unread) filter.readAt = null;
      const { skip, limit } = toSkipLimit(q);
      const [docs, total] = await Promise.all([
        Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).populate('complaint', 'publicId').populate('workOrder', 'publicId').lean(),
        Notification.countDocuments(filter),
      ]);
      const ref = (v: unknown) => (v && typeof v === 'object' && 'publicId' in v ? ((v as { publicId?: string }).publicId ?? null) : null);
      const items = docs.map((n) => ({
        id: String(n._id),
        type: n.type,
        title: n.title,
        message: n.message,
        complaintPublicId: ref(n.complaint),
        workOrderPublicId: ref(n.workOrder),
        disputeId: n.dispute ? String(n.dispute) : null,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt!.toISOString(),
      }));
      return { items, pagination: paginationMeta(q, total) };
    },

    async unreadCount(p: Principal) {
      return Notification.countDocuments({ recipient: new Types.ObjectId(p.userId), readAt: null });
    },

    /** Idempotent. Someone else's notification is 404, so IDs reveal nothing. */
    async markRead(p: Principal, id: string) {
      const n = await Notification.findOne({ _id: id, recipient: p.userId }).select('readAt').lean();
      if (!n) throw notFoundError('The notification');
      if (!n.readAt) await Notification.updateOne({ _id: id, recipient: p.userId, readAt: null }, { $set: { readAt: new Date() } });
      return { id, read: true };
    },

    async markAllRead(p: Principal) {
      const res = await Notification.updateMany({ recipient: new Types.ObjectId(p.userId), readAt: null }, { $set: { readAt: new Date() } });
      return { updated: res.modifiedCount };
    },
  };
}
export type NotificationService = ReturnType<typeof createNotificationService>;
