import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  ANALYSIS_STATUSES,
  ANALYSIS_TRIGGERS,
  ANALYSIS_TYPES,
  AUTHENTICITY_OUTCOMES,
  AUTHENTICITY_SIGNAL_SOURCES,
  CATEGORIES,
  CERTAINTY_LEVELS,
  PRIORITIES,
  PROVENANCE_STATES,
  RELEVANCE_ASSESSMENTS,
  REVIEW_DECISIONS,
  REVIEW_REASONS,
  VERIFICATION_OUTCOMES,
} from './enums.js';

// Everything here is model or rule output: untrusted, stored only after schema validation,
// and never treated as a committed decision. Decisions live on Complaint / WorkOrder.
// One record per run: re-running creates a new analysisVersion; the latest final one is current.

const confidence = { type: Number, min: 0, max: 1 };

const duplicateCandidateSchema = new Schema(
  {
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true },
    // Rule-based text similarity (0-1), not a probability that the reports are the same issue.
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

const authenticitySignalSchema = new Schema(
  {
    source: { type: String, enum: AUTHENTICITY_SIGNAL_SOURCES, required: true },
    // e.g. "c2pa_manifest_present", "generator_tag", "editor_tag", "visual_inconsistency_strong"
    finding: { type: String, required: true, maxlength: 60, match: /^[a-z0-9_]+$/ },
    detail: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false },
);

const authenticitySchema = new Schema(
  {
    outcome: { type: String, enum: AUTHENTICITY_OUTCOMES, required: true },
    provenance: { type: String, enum: PROVENANCE_STATES, required: true },
    signals: { type: [authenticitySignalSchema], default: [] },
    visualModelRun: { type: Boolean, required: true },
    explanation: { type: String, trim: true, maxlength: 600 },
    reviewRecommended: { type: Boolean, required: true },
  },
  { _id: false },
);

/** Whether the media seems to show what the complaint describes. Separate from authenticity. */
const relevanceSchema = new Schema(
  {
    assessment: { type: String, enum: RELEVANCE_ASSESSMENTS, required: true },
    explanation: { type: String, trim: true, maxlength: 400 },
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
    evidence: {
      type: Schema.Types.ObjectId,
      ref: 'Evidence',
      immutable: true,
      required(this: { analysisType?: string }) {
        return this.analysisType === 'MEDIA_AUTHENTICITY';
      },
    },
    analysisType: { type: String, enum: ANALYSIS_TYPES, required: true, immutable: true },
    status: { type: String, enum: ANALYSIS_STATUSES, required: true },
    // Increments per complaint + type (+ evidence) when an analysis is re-run.
    analysisVersion: { type: Number, required: true, min: 1, default: 1 },
    trigger: { type: String, enum: ANALYSIS_TRIGGERS },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    // ---- job state (background runner) ----
    // Set only while PENDING/RUNNING; unique, so at most one active job per complaint + type + evidence.
    activeJobKey: { type: String, maxlength: 120 },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    nextAttemptAt: { type: Date },
    lockedUntil: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },

    // ---- provider metadata. No keys, prompts or raw responses. ----
    provider: { type: String, trim: true, maxlength: 50 },
    modelName: { type: String, trim: true, maxlength: 100 },
    promptVersion: { type: String, trim: true, maxlength: 50 },
    latencyMs: { type: Number, min: 0 },
    usage: {
      inputTokens: { type: Number, min: 0 },
      outputTokens: { type: Number, min: 0 },
    },
    errorCode: { type: String, trim: true, maxlength: 100 }, // when status is not SUCCEEDED

    // ---- TRIAGE recommendations ----
    suggestedCategory: { type: String, enum: CATEGORIES },
    suggestedPriority: { type: String, enum: PRIORITIES },
    suggestedDepartment: { type: Schema.Types.ObjectId, ref: 'Department' },
    summary: { type: String, trim: true, maxlength: 300 }, // normalized summary; the citizen's text is untouched
    rationale: { type: String, trim: true, maxlength: 2000 },
    missingInformation: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    certainty: { type: String, enum: CERTAINTY_LEVELS },
    confidence, // reserved: only for a calibrated score from a documented source

    // ---- DUPLICATE_CANDIDATES ----
    duplicateCandidates: { type: [duplicateCandidateSchema], default: [] },

    reviewFlags: { type: [{ type: String, enum: REVIEW_REASONS }], default: [] },
    reviewRecommended: { type: Boolean },

    // ---- RESOLUTION_VERIFICATION (Phase 9) ----
    verification: { type: verificationSchema },

    // ---- MEDIA_AUTHENTICITY ----
    authenticity: { type: authenticitySchema },
    relevance: { type: relevanceSchema },

    // Set when a human accepts, changes or rejects this recommendation.
    humanReview: { type: humanReviewSchema },
  },
  { timestamps: true },
);

// One record per version. `evidence` is part of the key so each media file has its own sequence.
aiAnalysisSchema.index({ complaint: 1, analysisType: 1, evidence: 1, analysisVersion: -1 }, { unique: true });
aiAnalysisSchema.index({ activeJobKey: 1 }, { unique: true, sparse: true });
aiAnalysisSchema.index({ status: 1, nextAttemptAt: 1 }); // runner: due PENDING jobs
aiAnalysisSchema.index({ status: 1, lockedUntil: 1 }); // runner: expired RUNNING leases
aiAnalysisSchema.index({ workOrder: 1, createdAt: -1 }, { sparse: true });
aiAnalysisSchema.index({ evidence: 1, analysisVersion: -1 }, { sparse: true });

export type AIAnalysisFields = InferSchemaType<typeof aiAnalysisSchema>;
export const AIAnalysis = model('AIAnalysis', aiAnalysisSchema);
