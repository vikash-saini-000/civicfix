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
    // One work order per complaint. Reassignment and reopening update it rather than create another.
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, immutable: true },
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

    // Resolution submission. Files are Evidence records with purpose RESOLUTION.
    completionNotes: { type: String, trim: true, maxlength: 2000 },
    resolutionSubmittedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

workOrderSchema.index({ complaint: 1 }, { unique: true });
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
