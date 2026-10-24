// Provider-independent AI contracts. Business logic depends only on this file, never on a vendor SDK.
import { z } from 'zod';
import { CATEGORIES, CERTAINTY_LEVELS, PRIORITIES, RELEVANCE_ASSESSMENTS, REVIEW_REASONS } from '../models/enums.js';

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
}

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

// ---- provider ------------------------------------------------------------------

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly enabled: boolean;
  classifyComplaint(input: ClassificationInput): Promise<AiResult<ClassificationOutput>>;
  assessImage(input: ImageAssessmentInput): Promise<AiResult<ImageAssessment>>;
}

/** Used when AI_PROVIDER=disabled. Every call fails fast with NOT_CONFIGURED (not retried). */
export const disabledProvider: AiProvider = {
  name: 'disabled',
  model: 'none',
  enabled: false,
  async classifyComplaint() {
    throw new AiProviderError('NOT_CONFIGURED', 'AI analysis is not configured.');
  },
  async assessImage() {
    throw new AiProviderError('NOT_CONFIGURED', 'AI analysis is not configured.');
  },
};
