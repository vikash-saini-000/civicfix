import { Notification } from './Notification';
import type { ComplaintStatus } from '../lib/domain';

const RESOLUTION_STATUSES = new Set<ComplaintStatus>([
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
  'RESOLVED',
  'CLOSED',
]);

export function ResolutionWorkflowNotice({ status, audience }: { status: ComplaintStatus; audience: 'citizen' | 'staff' }) {
  if (!RESOLUTION_STATUSES.has(status)) return null;

  if (audience === 'citizen' && (status === 'RESOLVED' || status === 'CLOSED')) {
    return (
      <Notification kind="info" title="Public resolution and dispute details are unavailable">
        The current API has not defined approved public resolution evidence, verification details, or dispute eligibility. No private evidence or dispute form is shown.
      </Notification>
    );
  }

  return (
    <Notification kind="info" title="Resolution workflow is not configured">
      The current API does not provide an approved evidence-upload, resolution-submission, or verification contract for this status. No mutation controls are shown.
    </Notification>
  );
}
