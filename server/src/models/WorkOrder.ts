import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  ASSIGNED_WORK_ORDER_STATUSES,
  ASSIGNMENT_SOURCES,
  PRIORITIES,
  REVIEW_DECISIONS,
  REVIEW_REASONS,
  WORK_ORDER_STATUSES,
  type WorkOrderStatus,
} from './enums.js';

/** Manager-review record for an exception case. Recommendation and decision are kept apart. */
const managerReviewSchema = new Schema(
  {
    reasons: {
      type: [{ type: String, enum: REVIEW_REASONS }],
      validate: { validator: (r: string[]) => r.length > 0, message: 'at least one review reason is required' },
    },
    requestedAt: { type: Date, required: true },
    // AI recommendation this review is about (the AIAnalysis record holds the details).
    analysis: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
    decision: { type: String, enum: REVIEW_DECISIONS },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    decisionReason: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

/** One entry per operational event. Kept forever so reassignment and cancellation never lose history. */
const historySchema = new Schema(
  {
    at: { type: Date, required: true },
    action: { type: String, required: true, maxlength: 40, match: /^[a-z_]+$/ },
    actorType: { type: String, enum: ['USER', 'SYSTEM'], required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    fromStatus: { type: String, enum: WORK_ORDER_STATUSES },
    toStatus: { type: String, enum: WORK_ORDER_STATUSES },
    department: { type: Schema.Types.ObjectId, ref: 'Department' },
    assignee: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, trim: true, maxlength: 1000 },
    policyVersion: { type: String, maxlength: 40 },
  },
  { _id: false },
);

const verificationDecisionSchema = new Schema(
  {
    decision: { type: String, enum: ['APPROVED', 'REJECTED', 'MORE_EVIDENCE_REQUESTED'], required: true },
    source: { type: String, enum: ['VERIFIER', 'SYSTEM_POLICY'], required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date, required: true },
    reason: { type: String, trim: true, maxlength: 1000, required: true },
    analysis: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
  },
  { _id: false },
);

const workNoteSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    at: { type: Date, required: true },
  },
  { timestamps: false },
);

type WorkOrderThis = { status?: WorkOrderStatus };

const workOrderSchema = new Schema(
  {
    // Human-readable ID, e.g. WO-2026-00001. Set by the work-order service.
    publicId: { type: String, trim: true, uppercase: true, match: /^WO-\d{4}-\d{5,}$/, immutable: true },
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, immutable: true },
    // Equals `complaint` while the work order is open, unset once COMPLETED or CANCELLED.
    // Unique, so a complaint has at most one open work order; closed ones stay as history.
    activeFor: { type: Schema.Types.ObjectId },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    priority: { type: String, enum: PRIORITIES, required: true },
    status: { type: String, enum: WORK_ORDER_STATUSES, required: true, default: 'PENDING_ASSIGNMENT' },

    assignee: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required(this: WorkOrderThis) {
        return ASSIGNED_WORK_ORDER_STATUSES.includes(this.status!);
      },
    },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // empty for automatic assignment
    assignmentSource: { type: String, enum: ASSIGNMENT_SOURCES },
    assignmentReason: { type: String, trim: true, maxlength: 1000 },
    assignedAt: { type: Date },

    managerReview: { type: managerReviewSchema },

    dueAt: { type: Date },
    acceptedAt: { type: Date },
    startedAt: { type: Date },

    blockedReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      required(this: WorkOrderThis) {
        return this.status === 'BLOCKED';
      },
    },
    blockedNextAction: {
      type: String,
      trim: true,
      maxlength: 1000,
      required(this: WorkOrderThis) {
        return this.status === 'BLOCKED';
      },
    },
    blockedAt: { type: Date },

    notes: { type: [workNoteSchema], default: [] },
    history: { type: [historySchema], default: [] },

    cancelledAt: { type: Date },
    cancelReason: { type: String, trim: true, maxlength: 1000 },

    // Resolution submission. Files are Evidence records with purpose RESOLUTION.
    completionNotes: { type: String, trim: true, maxlength: 2000 },
    resolutionSubmittedAt: { type: Date },
    resolutionEvidence: { type: [{ type: Schema.Types.ObjectId, ref: 'Evidence' }], default: [] },
    verificationDecision: { type: verificationDecisionSchema },
    completedAt: { type: Date },
    reopenedCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

workOrderSchema.index({ publicId: 1 }, { unique: true, sparse: true });
workOrderSchema.index({ activeFor: 1 }, { unique: true, sparse: true }); // one open work order per complaint
workOrderSchema.index({ complaint: 1, createdAt: -1 });
workOrderSchema.index({ department: 1, status: 1, priority: 1, dueAt: 1 }); // department queue
workOrderSchema.index({ assignee: 1, status: 1, dueAt: 1 }); // personal queue
// Manager-review queue: pending reviews are those with requestedAt set and no decision yet.
workOrderSchema.index(
  { department: 1, 'managerReview.decision': 1, 'managerReview.requestedAt': 1 },
  { partialFilterExpression: { 'managerReview.requestedAt': { $exists: true } } },
);
workOrderSchema.index({ status: 1, dueAt: 1 }); // overdue checks

export type WorkOrderFields = InferSchemaType<typeof workOrderSchema>;
export const WorkOrder = model('WorkOrder', workOrderSchema);
