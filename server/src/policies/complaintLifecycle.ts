import type { ComplaintStatus, WorkOrderStatus } from '../models/enums.js';

/**
 * Every allowed complaint status change, the action that causes it, and the phase that implements it.
 * Status is never set directly by clients; only these actions move a complaint.
 * From phase 8 on, most complaint changes are mirrors of work-order changes (see workOrderLifecycle.ts).
 */
export const COMPLAINT_TRANSITIONS = [
  // Phase 6: manual triage.
  { action: 'classify', from: ['REPORTED', 'UNDER_REVIEW'], to: 'UNDER_REVIEW', phase: 6 },
  { action: 'reject', from: ['REPORTED', 'UNDER_REVIEW'], to: 'REJECTED', phase: 6 },
  // Phase 7: AI analysis starts review automatically.
  { action: 'start_review', from: ['REPORTED'], to: 'UNDER_REVIEW', phase: 7 },
  // Phase 8: assignment and work, mirrored from the work order.
  { action: 'assign', from: ['REPORTED', 'UNDER_REVIEW'], to: 'ASSIGNED', phase: 8 },
  { action: 'accept', from: ['ASSIGNED'], to: 'ACCEPTED', phase: 8 },
  { action: 'start_work', from: ['ACCEPTED', 'BLOCKED'], to: 'IN_PROGRESS', phase: 8 },
  { action: 'block', from: ['ACCEPTED', 'IN_PROGRESS'], to: 'BLOCKED', phase: 8 },
  { action: 'transfer', from: ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'], to: 'ASSIGNED', phase: 8 },
  { action: 'unassign', from: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'UNDER_REVIEW', phase: 8 },
  // Phase 9: resolution, verification, disputes.
  { action: 'submit_resolution', from: ['IN_PROGRESS', 'VERIFICATION_REQUIRED'], to: 'RESOLUTION_SUBMITTED', phase: 9 },
  { action: 'require_verification', from: ['RESOLUTION_SUBMITTED'], to: 'VERIFICATION_REQUIRED', phase: 9 },
  { action: 'approve_resolution', from: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'RESOLVED', phase: 9 },
  { action: 'reject_resolution', from: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'IN_PROGRESS', phase: 9 },
  { action: 'close', from: ['RESOLVED'], to: 'CLOSED', phase: 9 },
  { action: 'reopen', from: ['RESOLVED'], to: 'IN_PROGRESS', phase: 9 },
  // Linked duplicates still waiting in triage close together with their original report (system only).
  { action: 'close_with_original', from: ['REPORTED', 'UNDER_REVIEW'], to: 'CLOSED', phase: 9 },
] as const satisfies readonly { action: string; from: readonly ComplaintStatus[]; to: ComplaintStatus; phase: number }[];

export type ComplaintAction = (typeof COMPLAINT_TRANSITIONS)[number]['action'];

export const CURRENT_PHASE = 9;

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

/** The action that moves a complaint from one status to another, or null if that move is not allowed. */
export function complaintActionFor(from: ComplaintStatus, to: ComplaintStatus): ComplaintAction | null {
  const t = COMPLAINT_TRANSITIONS.find((x) => x.phase <= CURRENT_PHASE && x.to === to && (x.from as readonly string[]).includes(from));
  return t?.action ?? null;
}

/** Statuses at which the citizen's report is closed for good in the current workflow. */
export const TERMINAL_STATUSES: readonly ComplaintStatus[] = ['CLOSED', 'REJECTED'];

/** Complaint status a citizen sees for each work-order status. */
export const COMPLAINT_STATUS_FOR_WORK_ORDER: Record<WorkOrderStatus, ComplaintStatus> = {
  PENDING_ASSIGNMENT: 'ASSIGNED',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  BLOCKED: 'BLOCKED',
  RESOLUTION_SUBMITTED: 'RESOLUTION_SUBMITTED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  COMPLETED: 'RESOLVED',
  CANCELLED: 'UNDER_REVIEW',
};
