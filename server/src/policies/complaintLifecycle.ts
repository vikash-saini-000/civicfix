import type { ComplaintStatus } from '../models/enums.js';

/**
 * Every allowed complaint status change, the action that causes it, and the phase that implements it.
 * Status is never set directly by clients; only these actions move a complaint.
 * Actions whose phase is later than the current one are defined but not reachable yet.
 */
export const COMPLAINT_TRANSITIONS = [
  // Phase 6: manual triage until AI analysis exists.
  { action: 'classify', from: ['REPORTED', 'UNDER_REVIEW'], to: 'UNDER_REVIEW', phase: 6 },
  { action: 'reject', from: ['REPORTED', 'UNDER_REVIEW'], to: 'REJECTED', phase: 6 },
  // Phase 7: AI analysis starts review automatically.
  { action: 'start_review', from: ['REPORTED'], to: 'UNDER_REVIEW', phase: 7 },
  // Phase 8: work orders drive these, mirrored onto the complaint.
  { action: 'assign', from: ['UNDER_REVIEW'], to: 'ASSIGNED', phase: 8 },
  { action: 'accept', from: ['ASSIGNED'], to: 'ACCEPTED', phase: 8 },
  { action: 'start_work', from: ['ACCEPTED', 'BLOCKED'], to: 'IN_PROGRESS', phase: 8 },
  { action: 'block', from: ['ACCEPTED', 'IN_PROGRESS'], to: 'BLOCKED', phase: 8 },
  // Phase 9: evidence, verification and disputes.
  { action: 'submit_resolution', from: ['IN_PROGRESS'], to: 'RESOLUTION_SUBMITTED', phase: 9 },
  { action: 'require_verification', from: ['RESOLUTION_SUBMITTED'], to: 'VERIFICATION_REQUIRED', phase: 9 },
  { action: 'approve_resolution', from: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'RESOLVED', phase: 9 },
  { action: 'reject_resolution', from: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'IN_PROGRESS', phase: 9 },
  { action: 'close', from: ['RESOLVED'], to: 'CLOSED', phase: 9 },
  { action: 'reopen', from: ['RESOLVED', 'CLOSED'], to: 'IN_PROGRESS', phase: 9 },
] as const satisfies readonly { action: string; from: readonly ComplaintStatus[]; to: ComplaintStatus; phase: number }[];

export type ComplaintAction = (typeof COMPLAINT_TRANSITIONS)[number]['action'];

export const CURRENT_PHASE = 6;

/** Statuses an action may start from. Throws for actions not implemented yet, so they can't be used by accident. */
export function transitionFor(action: ComplaintAction): { from: readonly ComplaintStatus[]; to: ComplaintStatus } {
  const t = COMPLAINT_TRANSITIONS.find((x) => x.action === action)!;
  if (t.phase > CURRENT_PHASE) throw new Error(`Complaint action "${action}" is not available until phase ${t.phase}`);
  return t;
}

export function canTransition(action: ComplaintAction, status: ComplaintStatus): boolean {
  const t = COMPLAINT_TRANSITIONS.find((x) => x.action === action)!;
  return t.phase <= CURRENT_PHASE && (t.from as readonly string[]).includes(status);
}

/** Statuses at which the citizen's report is closed for good in the current workflow. */
export const TERMINAL_STATUSES: readonly ComplaintStatus[] = ['CLOSED', 'REJECTED'];
