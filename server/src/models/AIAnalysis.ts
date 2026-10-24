import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  ANALYSIS_STATUSES,
  ANALYSIS_TYPES,
  CATEGORIES,
  PRIORITIES,
  REVIEW_DECISIONS,
  REVIEW_REASONS,
  VERIFICATION_OUTCOMES,
} from './enums.js';

// Everything here is model output: untrusted, stored only after schema validation,
// and never treated as a committed decision. Decisions live on Complaint / WorkOrder.

const confidence = { type: Number, min: 0, max: 1 };

const duplicateCandidateSchema = new Schema(
  {
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    similarity: { ...confidence, required: true },
    distanceMeters: { type: Number, min: 0 },
    reason: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const verificationSchema = new Schema(
  {
    outcome: { type: String, enum: VERIFICATION_OUTCOMES, required: true },
    reasons: { type: [{ type: String, trim: true, maxlength: 500 }], default: [] },
    missingEvidence: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    evidence: { type: [{ type: Schema.Types.ObjectId, ref: 'Evidence' }], default: [] },
  },
  { _id: false },
);

const humanReviewSchema = new Schema(
  {
    decision: { type: String, enum: REVIEW_DECISIONS, required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedAt: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const aiAnalysisSchema = new Schema(
  {
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, immutable: true },
    workOrder: {
      type: Schema.Types.ObjectId,
      ref: 'WorkOrder',
      immutable: true,
      required(this: { analysisType?: string }) {
        return this.analysisType === 'RESOLUTION_VERIFICATION';
      },
    },
    analysisType: { type: String, enum: ANALYSIS_TYPES, required: true, immutable: true },
    status: { type: String, enum: ANALYSIS_STATUSES, required: true },
    // Increments per complaint + type when an analysis is re-run.
    analysisVersion: { type: Number, required: true, min: 1, default: 1 },

    // Provider metadata. No keys, prompts or raw responses.
    provider: { type: String, required: true, trim: true, maxlength: 50 },
    modelName: { type: String, required: true, trim: true, maxlength: 100 },
    promptVersion: { type: String, trim: true, maxlength: 50 },
    latencyMs: { type: Number, min: 0 },
    errorCode: { type: String, trim: true, maxlength: 100 }, // when status is not SUCCEEDED

    // TRIAGE recommendations.
    suggestedCategory: { type: String, enum: CATEGORIES },
    suggestedPriority: { type: String, enum: PRIORITIES },
    suggestedDepartment: { type: Schema.Types.ObjectId, ref: 'Department' },
    rationale: { type: String, trim: true, maxlength: 2000 },
    missingInformation: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    duplicateCandidates: { type: [duplicateCandidateSchema], default: [] },
    confidence,
    reviewFlags: { type: [{ type: String, enum: REVIEW_REASONS }], default: [] },

    // RESOLUTION_VERIFICATION / MEDIA_AUTHENTICITY assessment.
    verification: { type: verificationSchema },

    // Set when a human accepts, changes or rejects this recommendation.
    humanReview: { type: humanReviewSchema },
  },
  { timestamps: true },
);

aiAnalysisSchema.index({ complaint: 1, analysisType: 1, analysisVersion: -1 }, { unique: true });
aiAnalysisSchema.index({ workOrder: 1, createdAt: -1 }, { sparse: true });
aiAnalysisSchema.index({ status: 1, createdAt: -1 }); // failure monitoring

export type AIAnalysisFields = InferSchemaType<typeof aiAnalysisSchema>;
export const AIAnalysis = model('AIAnalysis', aiAnalysisSchema);
