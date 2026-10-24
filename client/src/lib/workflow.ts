import type { WorkOrderStatus } from '../api/operationsTypes';

type Tone = 'gray' | 'blue' | 'cyan' | 'purple' | 'green' | 'yellow' | 'red';

export const WORK_ORDER_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  PENDING_ASSIGNMENT: { label: 'Waiting for a team member', tone: 'yellow' },
  ASSIGNED: { label: 'Assigned', tone: 'blue' },
  ACCEPTED: { label: 'Accepted', tone: 'blue' },
  IN_PROGRESS: { label: 'In progress', tone: 'blue' },
  BLOCKED: { label: 'On hold', tone: 'yellow' },
  RESOLUTION_SUBMITTED: { label: 'Fix submitted', tone: 'purple' },
  VERIFICATION_REQUIRED: { label: 'Needs verification', tone: 'yellow' },
  COMPLETED: { label: 'Completed', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },
};

export function workOrderStatusMeta(status: WorkOrderStatus) {
  return WORK_ORDER_STATUS_META[status] ?? { label: status, tone: 'gray' as Tone };
}

/** Why the backend sent a case to a human (docs/api/ASSIGNMENTS_WORK_ORDERS.md). */
export const REVIEW_REASON_LABELS: Record<string, string> = {
  LOW_CONFIDENCE: 'AI was not confident',
  UNCLEAR_DEPARTMENT: 'Department unclear',
  NO_ELIGIBLE_MEMBER: 'No team member available',
  HIGH_URGENCY: 'Urgent (P1)',
  MULTI_DEPARTMENT: 'Several departments involved',
  AMBIGUOUS_DUPLICATE: 'Possible duplicate',
  POLICY_REQUIRES_APPROVAL: 'Policy requires approval',
  AI_UNAVAILABLE: 'AI analysis unavailable',
  CATEGORY_CONFLICT: "Citizen's category differs from AI",
  ASSIGNEE_DECLINED: 'Assignee declined',
  PUBLIC_SAFETY_HAZARD: 'Possible public-safety hazard',
  SPAM_SUSPECTED: 'Possible spam',
  AWAITING_CITIZEN_INFO: 'Waiting for the citizen',
};

export function reviewReasonLabel(reason: string): string {
  return REVIEW_REASON_LABELS[reason] ?? reason.replaceAll('_', ' ').toLowerCase();
}

/** Why an AI step failed, in plain words. Unknown codes fall back to a generic message. */
const AI_ERROR_LABELS: Record<string, string> = {
  CREDITS_EXHAUSTED: 'AI credits exhausted',
  TIMEOUT: 'the AI service took too long',
  UNAVAILABLE: 'the AI service was unavailable',
  RATE_LIMITED: 'the AI service was busy',
  AUTH_FAILED: 'the AI service rejected the API key',
  NOT_CONFIGURED: 'AI is not configured on this server',
  INVALID_OUTPUT: 'the AI gave an unusable answer',
  REFUSED: 'the AI declined to answer',
  BAD_REQUEST: 'the AI service rejected the request',
};
export function aiErrorLabel(code: string | null | undefined): string {
  return (code && AI_ERROR_LABELS[code]) || 'an unexpected AI error';
}

export const AUTHENTICITY_LABELS: Record<string, string> = {
  NOT_ANALYZED: 'Not checked',
  ANALYSIS_PENDING: 'Check running',
  NO_SUSPICIOUS_SIGNALS_DETECTED: 'No suspicious signals',
  POTENTIAL_MANIPULATION: 'Possible editing',
  POTENTIAL_SYNTHETIC_MEDIA: 'Possibly AI-generated',
  INCONCLUSIVE: 'Inconclusive',
  ANALYSIS_FAILED: 'Check failed',
};

export const EVIDENCE_PURPOSE_LABELS: Record<string, string> = {
  COMPLAINT_REPORT: 'Reported with complaint',
  ADDITIONAL: 'Added by citizen',
  WORK_PROGRESS: 'Work progress',
  RESOLUTION: 'Resolution evidence',
  DISPUTE: 'Dispute evidence',
};

export { ACCEPTED_MEDIA_TYPES as ACCEPTED_UPLOAD_TYPES } from './media';

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}
