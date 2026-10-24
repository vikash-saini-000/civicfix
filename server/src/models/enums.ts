// Controlled values shared by the models. Keep in sync with client/src/lib/domain.ts
// (statuses, categories, priorities) until the API contracts are published.

/** Platform-wide role. Department roles live in DepartmentMembership. */
export const PLATFORM_ROLES = ['CITIZEN', 'PLATFORM_ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const MEMBERSHIP_ROLES = ['MEMBER', 'MANAGER'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const CATEGORIES = ['roads', 'garbage', 'streetlight', 'water', 'drainage', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Citizen-facing complaint lifecycle (blueprint section 5). */
export const COMPLAINT_STATUSES = [
  'REPORTED',
  'UNDER_REVIEW',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'BLOCKED',
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
  'RESOLVED',
  'CLOSED',
  'REJECTED',
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/**
 * Operational work-order lifecycle. Kept separate from the complaint status
 * (blueprint section 5). Allowed transitions are defined in a later phase.
 */
export const WORK_ORDER_STATUSES = [
  'PENDING_ASSIGNMENT', // waiting for auto-assignment or manager review
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'BLOCKED',
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/** Work-order statuses in which someone must be assigned. */
export const ASSIGNED_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = [
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'BLOCKED',
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
];

/** AUTO = deterministic backend rule (never the AI on its own); MANAGER / ADMIN_OVERRIDE = human decision. */
export const ASSIGNMENT_SOURCES = ['AUTO', 'MANAGER', 'ADMIN_OVERRIDE'] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

/** Why a case was sent to the manager-review queue (blueprint section 2). */
export const REVIEW_REASONS = [
  'LOW_CONFIDENCE',
  'UNCLEAR_DEPARTMENT',
  'NO_ELIGIBLE_MEMBER',
  'HIGH_URGENCY',
  'MULTI_DEPARTMENT',
  'AMBIGUOUS_DUPLICATE',
  'POLICY_REQUIRES_APPROVAL',
  'AI_UNAVAILABLE',
  'CATEGORY_CONFLICT',
  'ASSIGNEE_DECLINED',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_DECISIONS = ['APPROVED', 'MODIFIED', 'REJECTED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const DUPLICATE_LINK_SOURCES = ['SYSTEM_RULE', 'MANAGER'] as const;
export type DuplicateLinkSource = (typeof DUPLICATE_LINK_SOURCES)[number];

/**
 * TRIAGE = complaint classification. DUPLICATE_CANDIDATES = possible duplicates (rule-based).
 * MEDIA_AUTHENTICITY = signals of synthetic or edited media for one evidence file.
 */
export const ANALYSIS_TYPES = ['TRIAGE', 'DUPLICATE_CANDIDATES', 'RESOLUTION_VERIFICATION', 'MEDIA_AUTHENTICITY'] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

/** PENDING/RUNNING are job states; the rest are final. */
export const ANALYSIS_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INVALID_OUTPUT'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_TRIGGERS = ['COMPLAINT_CREATED', 'MANUAL_RERUN', 'EVIDENCE_ADDED'] as const;
export type AnalysisTrigger = (typeof ANALYSIS_TRIGGERS)[number];

/** Model's own statement of how sure it is. Not a calibrated probability. */
export const CERTAINTY_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Certainty = (typeof CERTAINTY_LEVELS)[number];

/** Stored authenticity outcomes. NOT_ANALYZED / ANALYSIS_PENDING are derived in the API from the record's absence or job state. */
export const AUTHENTICITY_OUTCOMES = [
  'NO_SUSPICIOUS_SIGNALS_DETECTED',
  'POTENTIAL_MANIPULATION',
  'POTENTIAL_SYNTHETIC_MEDIA',
  'INCONCLUSIVE',
  'ANALYSIS_FAILED',
] as const;
export type AuthenticityOutcome = (typeof AUTHENTICITY_OUTCOMES)[number];

export const AUTHENTICITY_SIGNAL_SOURCES = ['FILE_FORMAT', 'PROVENANCE', 'METADATA', 'VISUAL_MODEL'] as const;
export const PROVENANCE_STATES = ['NOT_PRESENT', 'PRESENT_UNVERIFIED'] as const;
export const RELEVANCE_ASSESSMENTS = ['APPEARS_RELATED', 'APPEARS_UNRELATED', 'UNCLEAR'] as const;

export const VERIFICATION_OUTCOMES = ['SUFFICIENT', 'INSUFFICIENT', 'UNCERTAIN'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/** COMPLAINT_REPORT/ADDITIONAL: from the citizen. WORK_PROGRESS/RESOLUTION: from the assignee. DISPUTE: citizen, for a dispute. */
export const EVIDENCE_PURPOSES = ['COMPLAINT_REPORT', 'ADDITIONAL', 'WORK_PROGRESS', 'RESOLUTION', 'DISPUTE'] as const;
export type EvidencePurpose = (typeof EVIDENCE_PURPOSES)[number];

export const MEDIA_TYPES = ['IMAGE', 'VIDEO'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'] as const;

export const EVIDENCE_VERIFICATION_STATES = ['PENDING', 'ACCEPTED', 'REJECTED', 'NEEDS_REVIEW'] as const;
export type EvidenceVerificationState = (typeof EVIDENCE_VERIFICATION_STATES)[number];

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'AI'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ['SUCCESS', 'DENIED', 'FAILED'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Resource kinds that audit logs and notifications may point at. */
export const RESOURCE_TYPES = [
  'User',
  'Department',
  'DepartmentMembership',
  'Complaint',
  'WorkOrder',
  'AIAnalysis',
  'Evidence',
  'Dispute',
  'Feedback',
  'Notification',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const NOTIFICATION_TYPES = [
  'COMPLAINT_RECEIVED',
  'COMPLAINT_STATUS_CHANGED',
  'WORK_ORDER_ASSIGNED',
  'MANAGER_REVIEW_REQUIRED',
  'EVIDENCE_REQUESTED',
  'DISPUTE_SUBMITTED',
  'DISPUTE_DECIDED',
  'WORK_ORDER_UPDATED',
  'VERIFICATION_NEEDED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DELIVERY_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'UPHELD', 'DISMISSED', 'WITHDRAWN'] as const;
export const DISPUTE_CATEGORIES = ['NOT_FIXED', 'POOR_QUALITY', 'WRONG_LOCATION', 'OTHER'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const FEEDBACK_MODERATION_STATES = ['VISIBLE', 'HIDDEN'] as const;
export type FeedbackModerationState = (typeof FEEDBACK_MODERATION_STATES)[number];
