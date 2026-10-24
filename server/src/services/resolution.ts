import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { EventBus } from '../events/bus.js';
import type { DisputeStatus } from '../models/enums.js';
import { AIAnalysis, Complaint, Dispute, Evidence, Feedback, WorkOrder } from '../models/index.js';
import { AppError, notFoundError, validationError } from '../utils/errors.js';
import { paginationMeta, toSkipLimit, type PaginationQuery } from '../validation/pagination.js';
import { auditUserAction } from './audit.js';
import { relationTo, type ComplaintService } from './complaints.js';
import type { WorkOrderService } from './workOrders.js';

// ---- verification policy --------------------------------------------------------------------

export interface VerificationPolicy {
  version: string;
  minResolutionEvidence: number;
  /** Approve without a human when every rule passes. Off by default: needs product-owner approval. */
  autoApprove: boolean;
  /** Days after resolution in which the citizen may dispute, and before which staff may not close. */
  disputeWindowDays: number;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  version: 'verify-v1',
  minResolutionEvidence: 1,
  autoApprove: false,
  disputeWindowDays: 14,
};

export type VerificationOutcome = 'SUFFICIENT' | 'INSUFFICIENT' | 'UNCERTAIN';

/**
 * Rule-based check of a resolution submission. Photos never prove a repair is safe or durable; these
 * rules only decide whether the submission is complete and free of warning signs. AI authenticity
 * results can only make the outcome more cautious, never approve anything.
 */
export async function assessResolution(wo: { _id: Types.ObjectId; assignedAt?: Date | null }, evidenceIds: Types.ObjectId[], policy: VerificationPolicy) {
  const reasons: string[] = [];
  const missing: string[] = [];
  let outcome: VerificationOutcome = 'SUFFICIENT';
  const worse = (o: VerificationOutcome) => {
    if (o === 'INSUFFICIENT' || (o === 'UNCERTAIN' && outcome === 'SUFFICIENT')) outcome = o;
  };

  if (evidenceIds.length < policy.minResolutionEvidence) {
    worse('INSUFFICIENT');
    missing.push(`at least ${policy.minResolutionEvidence} resolution photo or video`);
  }
  const evidence = await Evidence.find({ _id: { $in: evidenceIds } }).select('createdAt').lean();
  if (wo.assignedAt && evidence.some((e) => e.createdAt && e.createdAt < wo.assignedAt!)) {
    worse('INSUFFICIENT');
    reasons.push('Some evidence was uploaded before the work was assigned.');
  }
  const checks = await AIAnalysis.find({ evidence: { $in: evidenceIds }, analysisType: 'MEDIA_AUTHENTICITY' }).sort({ analysisVersion: -1 }).select('evidence status authenticity').lean();
  for (const id of evidenceIds) {
    const latest = checks.find((c) => String(c.evidence) === String(id));
    const o = latest?.authenticity?.outcome;
    if (o === 'POTENTIAL_MANIPULATION' || o === 'POTENTIAL_SYNTHETIC_MEDIA') {
      worse('UNCERTAIN');
      reasons.push('A photo shows possible signs of editing or generation.');
    } else if (!latest || latest.status === 'PENDING' || latest.status === 'RUNNING') {
      worse('UNCERTAIN');
      reasons.push('Authenticity checks have not finished for every file.');
    } else if (o !== 'NO_SUSPICIOUS_SIGNALS_DETECTED') {
      worse('UNCERTAIN');
      reasons.push('Authenticity could not be assessed for every file.');
    }
  }
  if (outcome === 'SUFFICIENT') reasons.push('Required evidence is present, uploaded after assignment, with no warning signs.');
  return { outcome, reasons: [...new Set(reasons)], missingEvidence: missing };
}

// ---- service ------------------------------------------------------------------------------------

export interface ResolutionServiceDeps {
  events: EventBus;
  complaints: ComplaintService;
  workOrders: WorkOrderService;
  policy?: VerificationPolicy;
}

const OPEN_DISPUTE: DisputeStatus[] = ['OPEN', 'UNDER_REVIEW'];
const isAdmin = (p: Principal) => p.roles.has('PLATFORM_ADMIN');
const managesDept = (p: Principal, dept: unknown) => !!dept && p.memberships.some((m) => m.departmentId === String(dept) && m.role === 'MANAGER');

export function createResolutionService(deps: ResolutionServiceDeps) {
  const { events, workOrders } = deps;
  const policy = deps.policy ?? DEFAULT_VERIFICATION_POLICY;
  const days = (n: number) => n * 86_400_000;

  async function recordAssessment(wo: { _id: Types.ObjectId; complaint: Types.ObjectId }, evidenceIds: Types.ObjectId[], assessment: Awaited<ReturnType<typeof assessResolution>>) {
    const latest = await AIAnalysis.findOne({ complaint: wo.complaint, analysisType: 'RESOLUTION_VERIFICATION' }).sort({ analysisVersion: -1 }).select('analysisVersion').lean();
    return AIAnalysis.create({
      complaint: wo.complaint,
      workOrder: wo._id,
      analysisType: 'RESOLUTION_VERIFICATION',
      status: 'SUCCEEDED',
      analysisVersion: (latest?.analysisVersion ?? 0) + 1,
      provider: 'civicfix-rules',
      modelName: policy.version,
      attempts: 1,
      completedAt: new Date(),
      verification: { outcome: assessment.outcome, reasons: assessment.reasons, missingEvidence: assessment.missingEvidence, evidence: evidenceIds },
      reviewRecommended: assessment.outcome !== 'SUFFICIENT',
    });
  }

  function disputeView(d: Record<string, any>) {
    return {
      id: String(d._id),
      complaintId: String(d.complaint),
      workOrderId: String(d.workOrder),
      category: d.category,
      reason: d.reason,
      status: d.status,
      reviewerId: d.reviewer ? String(d.reviewer) : null,
      decision: d.decidedAt ? { decidedAt: d.decidedAt.toISOString(), reason: d.decisionReason } : null,
      priorResolution: { resolvedAt: d.priorResolution?.resolvedAt?.toISOString() ?? null, completionNotes: d.priorResolution?.completionNotes ?? null, evidenceIds: (d.priorResolution?.evidence ?? []).map(String) },
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  async function loadDispute(p: Principal, id: string) {
    const d = await Dispute.findById(id).lean();
    if (!d) throw notFoundError('The dispute');
    const complaint = await Complaint.findById(d.complaint).select('citizen department publicId').lean();
    const relation = complaint ? relationTo(p, complaint) : null;
    if (!complaint || !relation) throw notFoundError('The dispute');
    return { d, complaint, relation };
  }

  return {
    policy,

    /** Assignee submits completion notes + resolution evidence. Never resolves anything by itself. */
    async submitResolution(p: Principal, id: string, input: { completionNotes: string; evidenceIds: string[] }, requestId: string) {
      const { wo, roles } = await workOrders.load(p, id);
      if (!roles.has('ASSIGNEE')) throw new AppError('FORBIDDEN', 'Only the assignee can submit the resolution.');
      const ids = [...new Set(input.evidenceIds)].map((x) => new Types.ObjectId(x));
      const valid = await Evidence.countDocuments({ _id: { $in: ids }, workOrder: wo._id, purpose: 'RESOLUTION' });
      if (valid !== ids.length) throw validationError([{ field: 'body.evidenceIds', issue: 'invalid', message: 'Every file must be resolution evidence uploaded for this work order.' }]);
      if (ids.length < policy.minResolutionEvidence) {
        throw validationError([{ field: 'body.evidenceIds', issue: 'too_small', message: `Attach at least ${policy.minResolutionEvidence} resolution file.` }]);
      }
      const submitted = await workOrders.transition(wo, 'submit_resolution', { principal: p }, {
        set: { completionNotes: input.completionNotes, resolutionSubmittedAt: new Date(), resolutionEvidence: ids },
        unset: ['verificationDecision'],
        guard: { assignee: new Types.ObjectId(p.userId) },
        requestId,
      });
      await events.emit('resolution.submitted', { workOrderId: String(wo._id), complaintId: String(wo.complaint) }, `${wo._id}:resolution:${Date.now()}`);

      const assessment = await assessResolution(submitted as never, ids, policy);
      const record = await recordAssessment(submitted, ids, assessment);
      if (assessment.outcome === 'SUFFICIENT' && policy.autoApprove) {
        await workOrders.transition(submitted, 'approve', { system: true }, {
          set: { completedAt: new Date(), verificationDecision: { decision: 'APPROVED', source: 'SYSTEM_POLICY', decidedAt: new Date(), reason: `Automatic approval (${policy.version}).`, analysis: record._id } },
          reason: 'automatic approval by verification policy',
        });
        await events.emit('resolution.decided', { workOrderId: String(wo._id), complaintId: String(wo.complaint), decision: 'APPROVED' }, `${wo._id}:decided:${record._id}`);
      } else if (assessment.outcome !== 'SUFFICIENT') {
        await workOrders.transition(submitted, 'require_verification', { system: true }, { reason: assessment.reasons.concat(assessment.missingEvidence).join(' ') || assessment.outcome });
      }
      return { workOrder: await workOrders.get(p, String(wo._id)), assessment: { outcome: assessment.outcome, reasons: assessment.reasons, missingEvidence: assessment.missingEvidence } };
    },

    /** A manager of the department or an admin (who is not the assignee) records the verification decision. */
    async decide(p: Principal, id: string, input: { decision: 'APPROVE' | 'REJECT' | 'REQUEST_EVIDENCE'; reason: string }, requestId: string) {
      const { wo, roles } = await workOrders.load(p, id);
      if (!(roles.has('MANAGER') || roles.has('ADMIN')) || roles.has('ASSIGNEE')) {
        throw new AppError('FORBIDDEN', 'A manager of this department or an administrator, other than the assignee, must verify the work.');
      }
      if (!['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'].includes(wo.status)) throw new AppError('CONFLICT', `There is no resolution to verify while the work order is ${wo.status}.`);
      const latest = await AIAnalysis.findOne({ workOrder: wo._id, analysisType: 'RESOLUTION_VERIFICATION' }).sort({ analysisVersion: -1 }).select('_id').lean();
      const now = new Date();
      const decision = { decision: input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'MORE_EVIDENCE_REQUESTED', source: 'VERIFIER', decidedBy: new Types.ObjectId(p.userId), decidedAt: now, reason: input.reason, analysis: latest?._id };
      let next;
      if (input.decision === 'APPROVE') {
        next = await workOrders.transition(wo, 'approve', { principal: p }, { set: { completedAt: now, verificationDecision: decision }, reason: input.reason, requestId });
      } else if (input.decision === 'REJECT') {
        next = await workOrders.transition(wo, 'reject_resolution', { principal: p }, { set: { verificationDecision: decision }, reason: input.reason, requestId, note: 'The fix was not accepted after review. Work continues.' });
      } else {
        if (wo.status === 'VERIFICATION_REQUIRED') throw new AppError('CONFLICT', 'More evidence has already been requested.');
        next = await workOrders.transition(wo, 'require_verification', { principal: p }, { set: { verificationDecision: decision }, reason: input.reason, requestId });
      }
      if (latest) await AIAnalysis.updateOne({ _id: latest._id }, { $set: { humanReview: { decision: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewedBy: p.userId, reviewedAt: now, note: input.reason } } });
      await events.emit('resolution.decided', { workOrderId: String(wo._id), complaintId: String(wo.complaint), decision: decision.decision }, `${wo._id}:decided:${now.getTime()}`);
      return workOrders.toView(p, next);
    },

    // ---- disputes ----

    async createDispute(p: Principal, publicId: string, input: { reason: string; category?: 'NOT_FIXED' | 'POOR_QUALITY' | 'WRONG_LOCATION' | 'OTHER' }, requestId: string) {
      const { complaintId, relation } = await deps.complaints.access(p, publicId);
      if (relation !== 'reporter') throw new AppError('FORBIDDEN', 'Only the person who reported this can dispute the resolution.');
      const complaint = await Complaint.findById(complaintId).select('status resolvedAt').lean();
      if (!complaint || complaint.status !== 'RESOLVED' || !complaint.resolvedAt) throw new AppError('CONFLICT', 'Only a resolved complaint can be disputed.');
      if (Date.now() - complaint.resolvedAt.getTime() > days(policy.disputeWindowDays)) throw new AppError('CONFLICT', `Disputes must be raised within ${policy.disputeWindowDays} days of resolution.`);
      const wo = await WorkOrder.findOne({ complaint: complaintId, status: 'COMPLETED' }).sort({ completedAt: -1 }).lean();
      if (!wo) throw new AppError('CONFLICT', 'No completed work was found for this complaint.');
      const verification = await AIAnalysis.findOne({ workOrder: wo._id, analysisType: 'RESOLUTION_VERIFICATION' }).sort({ analysisVersion: -1 }).select('_id').lean();
      let dispute;
      try {
        dispute = await Dispute.create({
          complaint: complaintId,
          workOrder: wo._id,
          submittedBy: p.userId,
          reason: input.reason,
          category: input.category ?? 'NOT_FIXED',
          activeFor: complaintId,
          priorResolution: { completionNotes: wo.completionNotes, resolutionSubmittedAt: wo.resolutionSubmittedAt, resolvedAt: complaint.resolvedAt, verification: verification?._id, evidence: wo.resolutionEvidence },
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'There is already an open dispute for this complaint.');
        throw err;
      }
      await auditUserAction({ actor: p, action: 'dispute.created', targetType: 'Dispute', targetId: dispute._id, requestId, changes: [{ field: 'category', after: dispute.category }] });
      await events.emit('dispute.created', { disputeId: String(dispute._id), complaintId: String(complaintId) }, `${dispute._id}:created`);
      return disputeView(dispute.toObject());
    },

    async listDisputes(p: Principal, q: PaginationQuery & { scope: 'mine' | 'department' | 'all'; status?: DisputeStatus[] }) {
      let scope: Record<string, unknown>;
      if (q.scope === 'mine') scope = { submittedBy: new Types.ObjectId(p.userId) };
      else if (q.scope === 'department') {
        const depts = p.memberships.map((m) => new Types.ObjectId(m.departmentId));
        if (depts.length === 0) throw new AppError('FORBIDDEN', 'You are not an active member of any department.');
        const wos = await WorkOrder.find({ department: { $in: depts } }).select('_id').limit(5000).lean();
        scope = { workOrder: { $in: wos.map((w) => w._id) } };
      } else {
        if (!isAdmin(p)) throw new AppError('FORBIDDEN', 'Only platform administrators can list all disputes.');
        scope = {};
      }
      const filter = { ...scope, ...(q.status?.length && { status: { $in: q.status } }) };
      const { skip, limit } = toSkipLimit(q);
      const [docs, total] = await Promise.all([Dispute.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Dispute.countDocuments(filter)]);
      return { items: docs.map(disputeView), pagination: paginationMeta(q, total) };
    },

    async getDispute(p: Principal, id: string) {
      const { d } = await loadDispute(p, id);
      return disputeView(d);
    },

    async startDisputeReview(p: Principal, id: string, requestId: string) {
      const { d, complaint } = await loadDispute(p, id);
      if (!isAdmin(p) && !managesDept(p, complaint.department)) throw new AppError('FORBIDDEN', 'Only this department’s managers or administrators can review disputes.');
      const updated = await Dispute.findOneAndUpdate({ _id: d._id, status: 'OPEN' }, { $set: { status: 'UNDER_REVIEW', reviewer: p.userId } }, { returnDocument: 'after' }).lean();
      if (!updated) throw new AppError('CONFLICT', 'This dispute is not open.');
      await auditUserAction({ actor: p, action: 'dispute.review_started', targetType: 'Dispute', targetId: d._id, requestId });
      return disputeView(updated);
    },

    /** UPHOLD reopens the work (complaint back to IN_PROGRESS); DISMISS keeps the resolution. Final once recorded. */
    async decideDispute(p: Principal, id: string, input: { decision: 'UPHOLD' | 'DISMISS'; reason: string }, requestId: string) {
      const { d, complaint } = await loadDispute(p, id);
      if (!isAdmin(p) && !managesDept(p, complaint.department)) throw new AppError('FORBIDDEN', 'Only this department’s managers or administrators can decide disputes.');
      const status = input.decision === 'UPHOLD' ? 'UPHELD' : 'DISMISSED';
      const now = new Date();
      // Conditional on still being open: a finalized decision can't be overwritten.
      const decided = await Dispute.findOneAndUpdate(
        { _id: d._id, status: { $in: OPEN_DISPUTE } },
        { $set: { status, decidedBy: p.userId, decidedAt: now, decisionReason: input.reason, reviewer: d.reviewer ?? p.userId }, $unset: { activeFor: 1 } },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      if (!decided) throw new AppError('CONFLICT', 'This dispute has already been decided or withdrawn.');
      if (status === 'UPHELD') {
        const wo = await WorkOrder.findById(d.workOrder).lean();
        try {
          if (!wo || wo.status !== 'COMPLETED') throw new AppError('CONFLICT', 'The disputed work order is no longer completed.');
          await workOrders.transition(wo as never, 'reopen', { principal: p }, { set: { reopenedCount: (wo.reopenedCount ?? 0) + 1, verificationDecision: undefined }, unset: ['completedAt'], reason: `Dispute upheld: ${input.reason}`, complaintUnset: ['resolvedAt'], note: 'Reopened after your dispute. The team will continue the work.', requestId });
        } catch (err) {
          // Undo the decision so the dispute stays open and consistent with the work order.
          await Dispute.updateOne({ _id: d._id, status: 'UPHELD' }, { $set: { status: d.status, activeFor: d.complaint }, $unset: { decidedBy: 1, decidedAt: 1, decisionReason: 1 } });
          throw err;
        }
      }
      await auditUserAction({ actor: p, action: 'dispute.decided', targetType: 'Dispute', targetId: d._id, requestId, reason: input.reason, changes: [{ field: 'status', before: d.status, after: status }] });
      await events.emit('dispute.decided', { disputeId: String(d._id), complaintId: String(d.complaint), decision: status }, `${d._id}:decided`);
      return disputeView(decided);
    },

    async withdrawDispute(p: Principal, id: string, requestId: string) {
      const { d } = await loadDispute(p, id);
      if (String(d.submittedBy) !== p.userId) throw new AppError('FORBIDDEN', 'Only the person who raised the dispute can withdraw it.');
      const updated = await Dispute.findOneAndUpdate({ _id: d._id, status: { $in: OPEN_DISPUTE } }, { $set: { status: 'WITHDRAWN' }, $unset: { activeFor: 1 } }, { returnDocument: 'after' }).lean();
      if (!updated) throw new AppError('CONFLICT', 'This dispute is no longer open.');
      await auditUserAction({ actor: p, action: 'dispute.withdrawn', targetType: 'Dispute', targetId: d._id, requestId });
      return disputeView(updated);
    },

    // ---- closing and feedback ----

    /**
     * Closes a resolved complaint. The reporter may close any time (confirming the fix); staff may close
     * only after the dispute window. Never while a dispute is open.
     */
    async close(p: Principal, publicId: string, requestId: string) {
      const { complaintId, relation, departmentId } = await deps.complaints.access(p, publicId);
      const complaint = await Complaint.findById(complaintId).select('status resolvedAt').lean();
      if (!complaint || complaint.status !== 'RESOLVED') throw new AppError('CONFLICT', 'Only a resolved complaint can be closed.');
      if (relation !== 'reporter') {
        if (!isAdmin(p) && !managesDept(p, departmentId)) throw new AppError('FORBIDDEN', 'Only the reporter, this department’s managers or administrators can close this complaint.');
        if (!complaint.resolvedAt || Date.now() - complaint.resolvedAt.getTime() < days(policy.disputeWindowDays)) {
          throw new AppError('CONFLICT', `Staff can close a complaint ${policy.disputeWindowDays} days after it was resolved.`);
        }
      }
      if (await Dispute.exists({ complaint: complaintId, status: { $in: OPEN_DISPUTE } })) throw new AppError('CONFLICT', 'This complaint has an open dispute and cannot be closed yet.');
      const now = new Date();
      const closed = await Complaint.findOneAndUpdate(
        { _id: complaintId, status: 'RESOLVED' },
        { $set: { status: 'CLOSED', closedAt: now }, $push: { statusHistory: { status: 'CLOSED', at: now, publicNote: relation === 'reporter' ? 'You confirmed the fix. This complaint is complete.' : 'This complaint is complete.' } } },
      ).lean();
      if (!closed) throw new AppError('CONFLICT', 'The complaint changed at the same time. Reload and try again.');
      // A dispute opened in the same instant would be orphaned; re-check and undo if so.
      if (await Dispute.exists({ complaint: complaintId, status: { $in: OPEN_DISPUTE } })) {
        await Complaint.updateOne({ _id: complaintId, status: 'CLOSED' }, { $set: { status: 'RESOLVED' }, $unset: { closedAt: 1 }, $pop: { statusHistory: 1 } });
        throw new AppError('CONFLICT', 'A dispute was opened at the same time. The complaint stays open.');
      }
      await auditUserAction({ actor: p, action: 'complaint.closed', targetType: 'Complaint', targetId: complaintId, requestId, changes: [{ field: 'status', before: 'RESOLVED', after: 'CLOSED' }] });
      await events.emit('complaint.status_changed', { complaintId: String(complaintId), from: 'RESOLVED', to: 'CLOSED' }, `${complaintId}:CLOSED`);
      return deps.complaints.get(p, publicId);
    },

    async feedback(p: Principal, publicId: string, input: { rating: number; comment?: string }, requestId: string) {
      const { complaintId, relation } = await deps.complaints.access(p, publicId);
      if (relation !== 'reporter') throw new AppError('FORBIDDEN', 'Only the person who reported this can leave feedback.');
      const complaint = await Complaint.findById(complaintId).select('status').lean();
      if (!complaint || !['RESOLVED', 'CLOSED'].includes(complaint.status)) throw new AppError('CONFLICT', 'Feedback can be left once the complaint is resolved.');
      let f;
      try {
        f = await Feedback.create({ complaint: complaintId, citizen: p.userId, rating: input.rating, comment: input.comment });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'You have already left feedback for this complaint.');
        throw err;
      }
      await auditUserAction({ actor: p, action: 'feedback.created', targetType: 'Feedback', targetId: f._id, requestId, changes: [{ field: 'rating', after: input.rating }] });
      return { id: String(f._id), rating: f.rating, comment: f.comment ?? null, createdAt: f.createdAt!.toISOString() };
    },
  };
}
export type ResolutionService = ReturnType<typeof createResolutionService>;
