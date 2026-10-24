// Provider-independent AI contracts. Business logic depends only on this file, never on a vendor SDK.
import { z } from 'zod';
import { CATEGORIES, CERTAINTY_LEVELS, COMPARISON_ANSWERS, PRIORITIES, RELEVANCE_ASSESSMENTS, REVIEW_REASONS } from '../models/enums.js';

export { COMPARISON_ANSWERS };

/** Why a provider call failed. `retryable` decides whether the job runner tries again. */
export type AiErrorKind =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'REFUSED'
  | 'INVALID_OUTPUT'
  | 'BAD_REQUEST'
  | 'AUTH_FAILED';

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set(['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE']);

export class AiProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    /** Provider's own error text, for server logs only (never returned to API clients). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
}

export interface AiCallMeta {
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiResult<T> {
  output: T;
  meta: AiCallMeta;
}

// ---- complaint classification ---------------------------------------------------

/** A department the model may pick, referenced by a short opaque code so it can't invent database IDs. */
export interface DepartmentOption {
  ref: string; // "D1", "D2", ...
  name: string;
  categories: string[];
}

export interface ClassificationInput {
  title: string;
  description: string;
  landmark?: string | null;
  citizenCategory?: string | null;
  departments: DepartmentOption[];
  /** Server-computed facts about the place (ward, nearby schools/hospitals/main roads, nearby reports). */
  locationContext?: Record<string, unknown> | null;
  /** Earlier follow-up questions and the citizen's answers, when re-triaging. */
  followUp?: { question: string; answer: string }[] | null;
}

/** At most this many follow-up questions per complaint. */
export const MAX_FOLLOW_UP_QUESTIONS = 3;

/** Builds the output schema for one request: departmentRef must be one of the offered codes or null. */
export function classificationOutputSchema(departmentRefs: string[]) {
  const ref = departmentRefs.length > 0 ? z.enum(departmentRefs as [string, ...string[]]).nullable() : z.null();
  return z.strictObject({
    category: z.enum(CATEGORIES),
    departmentRef: ref,
    priority: z.enum(PRIORITIES),
    certainty: z.enum(CERTAINTY_LEVELS),
    summary: z.string().min(1).max(300),
    rationale: z.string().min(1).max(600),
    missingInformation: z.array(z.string().min(1).max(200)).max(5),
    reviewRecommended: z.boolean(),
    reviewReasons: z.array(z.enum(REVIEW_REASONS)).max(REVIEW_REASONS.length),
    // The model's own 0-1 estimate that category and department are right. Not calibrated.
    confidence: z.number().min(0).max(1),
    publicSafetyHazard: z.boolean(),
    spamLikely: z.boolean(),
    // Short questions to the citizen, in the language of their report. Empty if nothing important is missing.
    followUpQuestions: z.array(z.string().min(3).max(200)).max(MAX_FOLLOW_UP_QUESTIONS),
  });
}
export type ClassificationOutput = z.infer<ReturnType<typeof classificationOutputSchema>>;

// ---- image assessment (visual consistency + relevance) ---------------------------

export const VISUAL_INCONSISTENCY = ['NONE_OBSERVED', 'SOME', 'STRONG'] as const;

export const imageAssessmentSchema = z.strictObject({
  visualInconsistency: z.enum(VISUAL_INCONSISTENCY),
  inconsistencyNotes: z.string().max(300),
  relevance: z.enum(RELEVANCE_ASSESSMENTS),
  relevanceNotes: z.string().max(300),
});
export type ImageAssessment = z.infer<typeof imageAssessmentSchema>;

export interface ImageAssessmentInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
  complaintTitle: string;
  complaintDescription: string;
}

// ---- privacy: faces and number plates ----------------------------------------------

/** Box in relative coordinates (0-1 of width/height, origin top-left). */
const box = { x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) };
export const privacyRegionsSchema = z.strictObject({
  regions: z.array(z.strictObject({ kind: z.enum(['FACE', 'LICENSE_PLATE']), ...box })).max(40),
});
export type PrivacyRegions = z.infer<typeof privacyRegionsSchema>;

// ---- before/after resolution comparison ------------------------------------------

export const resolutionComparisonSchema = z.strictObject({
  sameLocation: z.enum(COMPARISON_ANSWERS),
  issueAppearsFixed: z.enum(COMPARISON_ANSWERS),
  matchesCategory: z.enum(COMPARISON_ANSWERS),
  notes: z.string().max(400),
});
export type ResolutionComparison = z.infer<typeof resolutionComparisonSchema>;

export interface ImageData {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export interface ResolutionComparisonInput {
  /** Photos from the citizen's report (may be empty). */
  before: ImageData[];
  /** One photo submitted as proof of the fix. */
  after: ImageData;
  category: string;
  complaintTitle: string;
  complaintDescription: string;
}

// ---- tool-using agent ----------------------------------------------------------

/** A narrow, read-only backend capability the model may call. Input is validated before `run`. */
export interface AgentTool {
  /** Lowercase snake_case, as shown to the model. */
  name: string;
  description: string;
  input: z.ZodType;
  /** Returns JSON-serialisable data. Throwing reports a generic tool failure to the model. */
  run(input: any): Promise<unknown>;
}

/** One tool call, for the stored trace. No arguments or results are kept. */
export interface AgentStep {
  tool: string;
  ok: boolean;
  ms: number;
}

export interface AgentRunInput<S extends z.ZodType> {
  system: string;
  userMessage: string;
  tools: AgentTool[];
  /** The model finishes by calling this tool; its input must match `schema`. */
  final: { name: string; description: string; schema: S };
  /** Max model calls in one run. */
  maxTurns: number;
  /** Wall-clock budget for the whole run, in ms. */
  deadlineMs: number;
  promptVersion: string;
}

export interface AgentResult<T> extends AiResult<T> {
  steps: AgentStep[];
  turns: number;
}

// ---- provider ------------------------------------------------------------------

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly enabled: boolean;
  classifyComplaint(input: ClassificationInput): Promise<AiResult<ClassificationOutput>>;
  assessImage(input: ImageAssessmentInput): Promise<AiResult<ImageAssessment>>;
  /** Optional: bounded tool-calling loop. Providers without it use classifyComplaint for triage. */
  runAgent?<S extends z.ZodType>(input: AgentRunInput<S>): Promise<AgentResult<z.infer<S>>>;
  /** Optional: before/after photo comparison for resolution checks. Missing means "not checked". */
  compareResolution?(input: ResolutionComparisonInput): Promise<AiResult<ResolutionComparison>>;
  /** Optional: locate faces and number plates so they can be blurred. Missing means metadata-only redaction. */
  detectPrivacyRegions?(input: ImageData): Promise<AiResult<PrivacyRegions>>;
}

const notConfigured = async (): Promise<never> => {
  throw new AiProviderError('NOT_CONFIGURED', 'AI analysis is not configured.');
};

/** Used when AI_PROVIDER=disabled. Every call fails fast with NOT_CONFIGURED (not retried). */
export const disabledProvider: AiProvider = {
  name: 'disabled',
  model: 'none',
  enabled: false,
  classifyComplaint: notConfigured,
  assessImage: notConfigured,
  runAgent: notConfigured,
  compareResolution: notConfigured,
  detectPrivacyRegions: notConfigured,
};
