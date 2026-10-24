import { Schema, model, type InferSchemaType } from 'mongoose';
import { DISPUTE_CATEGORIES, DISPUTE_STATUSES } from './enums.js';

type DisputeThis = { status?: string };
const isDecided = function (this: DisputeThis) {
  return this.status === 'UPHELD' || this.status === 'DISMISSED';
};

/** Snapshot of the resolution being disputed, so reopening never loses it. */
const priorResolutionSchema = new Schema(
  {
    completionNotes: { type: String, trim: true, maxlength: 2000 },
    resolutionSubmittedAt: { type: Date },
    resolvedAt: { type: Date, required: true },
    verification: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
    evidence: { type: [{ type: Schema.Types.ObjectId, ref: 'Evidence' }], default: [] },
  },
  { _id: false },
);

const disputeSchema = new Schema(
  {
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, immutable: true },
    workOrder: { type: Schema.Types.ObjectId, ref: 'WorkOrder', required: true, immutable: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    reason: { type: String, required: true, trim: true, minlength: 10, maxlength: 2000, immutable: true },
    category: { type: String, enum: DISPUTE_CATEGORIES, required: true, default: 'NOT_FIXED', immutable: true },
    // Equals `complaint` while the dispute is OPEN or UNDER_REVIEW; unique, so one open dispute per complaint.
    activeFor: { type: Schema.Types.ObjectId },
    priorResolution: { type: priorResolutionSchema, required: true, immutable: true },
    // Dispute photos are Evidence records with purpose DISPUTE.

    status: { type: String, enum: DISPUTE_STATUSES, required: true, default: 'OPEN' },
    reviewer: { type: Schema.Types.ObjectId, ref: 'User' },
    decisionReason: { type: String, trim: true, maxlength: 2000, required: isDecided },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: isDecided },
    decidedAt: { type: Date, required: isDecided },
  },
  { timestamps: true },
);

disputeSchema.index({ complaint: 1, createdAt: -1 });
disputeSchema.index({ activeFor: 1 }, { unique: true, sparse: true });
disputeSchema.index({ status: 1, createdAt: 1 }); // review queue
disputeSchema.index({ submittedBy: 1, createdAt: -1 });

export type DisputeFields = InferSchemaType<typeof disputeSchema>;
export const Dispute = model('Dispute', disputeSchema);
