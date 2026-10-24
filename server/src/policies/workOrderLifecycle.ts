import type { WorkOrderStatus } from '../models/enums.js';

/**
 * Work-order transition matrix. Who may act is enforced in the work-order service:
 *   ASSIGNEE = the user assigned to the work order (active member of its department)
 *   MANAGER  = an active manager of the work order's department
 *   ADMIN    = platform administrator
 *   VERIFIER = MANAGER or ADMIN who is not the assignee
 *   SYSTEM   = backend policy (automatic assignment / verification)
 */
export const WORK_ORDER_TRANSITIONS = {
  assign_staff: { from: ['PENDING_ASSIGNMENT', 'ASSIGNED'], to: 'ASSIGNED', actors: ['MANAGER', 'ADMIN', 'SYSTEM'], requires: ['assigneeId'] },
  decline: { from: ['ASSIGNED'], to: 'PENDING_ASSIGNMENT', actors: ['ASSIGNEE'], requires: ['reason'] },
  accept: { from: ['ASSIGNED'], to: 'ACCEPTED', actors: ['ASSIGNEE'], requires: [] },
  start: { from: ['ACCEPTED', 'BLOCKED'], to: 'IN_PROGRESS', actors: ['ASSIGNEE'], requires: [] },
  block: { from: ['ACCEPTED', 'IN_PROGRESS'], to: 'BLOCKED', actors: ['ASSIGNEE'], requires: ['reason', 'nextAction'] },
  transfer: { from: ['PENDING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED'], to: 'PENDING_ASSIGNMENT', actors: ['ADMIN'], requires: ['departmentId', 'reason'] },
  cancel: { from: ['PENDING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED'], to: 'CANCELLED', actors: ['MANAGER', 'ADMIN'], requires: ['reason'] },
  // Phase 9
  submit_resolution: { from: ['IN_PROGRESS', 'VERIFICATION_REQUIRED'], to: 'RESOLUTION_SUBMITTED', actors: ['ASSIGNEE'], requires: ['completionNotes', 'evidenceIds'] },
  require_verification: { from: ['RESOLUTION_SUBMITTED'], to: 'VERIFICATION_REQUIRED', actors: ['SYSTEM', 'VERIFIER'], requires: ['reason'] },
  approve: { from: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'COMPLETED', actors: ['VERIFIER', 'SYSTEM'], requires: ['reason'] },
  reject_resolution: { from: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'], to: 'IN_PROGRESS', actors: ['VERIFIER'], requires: ['reason'] },
  reopen: { from: ['COMPLETED'], to: 'IN_PROGRESS', actors: ['VERIFIER'], requires: ['reason'] },
} as const satisfies Record<string, { from: readonly WorkOrderStatus[]; to: WorkOrderStatus; actors: readonly string[]; requires: readonly string[] }>;

export type WorkOrderAction = keyof typeof WORK_ORDER_TRANSITIONS;

export const OPEN_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = [
  'PENDING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'BLOCKED',
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
];
export const TERMINAL_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = ['COMPLETED', 'CANCELLED'];

export function canWorkOrderTransition(action: WorkOrderAction, status: WorkOrderStatus): boolean {
  return (WORK_ORDER_TRANSITIONS[action].from as readonly string[]).includes(status);
}
