import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import type { ResolutionAssessment, VerificationDecision, WorkOrder } from '../api/operationsTypes';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/Badge';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorState, LoadingIndicator } from '../components/Feedback';
import { Select, TextArea } from '../components/Field';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { PriorityBadge } from '../components/Tag';
import { AnalysisPanel, EvidencePanel, ReasonAction, ReviewReasons, WorkOrderStatusTag } from '../components/Workflow';
import { formatDateTime } from '../lib/domain';
import { useAction, useResource } from '../lib/useResource';
import { workOrderStatusMeta } from '../lib/workflow';

const OPEN = ['PENDING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'];

export function WorkOrderDetailPage() {
  const { workOrderId = '' } = useParams<{ workOrderId?: string }>();
  const [refreshKey, setRefreshKey] = useState(0);
  const resource = useResource((signal) => api.getWorkOrder(workOrderId, signal), [workOrderId, refreshKey]);
  const [assessment, setAssessment] = useState<ResolutionAssessment | null>(null);
  const isAdmin = useAuth().state.user?.role === 'platform_admin';
  const back = isAdmin ? '/admin/work-orders' : '/department/work';
  const complaintBase = isAdmin ? '/admin/triage' : '/department/complaints';
  const changed = () => setRefreshKey((value) => value + 1);

  if (resource.loading && !resource.data) {
    return (
      <Page title="Loading work order">
        <LoadingIndicator label="Loading work order" />
      </Page>
    );
  }
  if (resource.error || !resource.data) {
    return (
      <Page title="Work order unavailable">
        <div className="max-w-xl">
          <ErrorState
            title={resource.error ? 'We could not load this work order' : 'Work order not found'}
            description={resource.error ?? `There is no work order ${workOrderId} that you can see.`}
            onRetry={resource.error ? resource.reload : undefined}
          />
          <ButtonLink to={back} variant="ghost" className="mt-4 -ml-4">← Back to work orders</ButtonLink>
        </div>
      </Page>
    );
  }

  const wo = resource.data;
  const can = (action: string) => wo.allowedActions.includes(action);
  return (
    <Page
      title={wo.complaint?.title ?? 'Work order'}
      intro={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-ink">{wo.publicId}</span>
          <WorkOrderStatusTag status={wo.status} />
          <PriorityBadge priority={wo.priority} />
          {wo.overdue && <Badge tone="error">Overdue</Badge>}
        </span>
      }
      actions={<Button variant="tertiary" onClick={changed}>Refresh</Button>}
    >
      {assessment && (
        <Notification
          kind={assessment.outcome === 'SUFFICIENT' ? 'success' : 'warning'}
          title={assessment.outcome === 'SUFFICIENT' ? 'Fix submitted. Automatic checks passed; a verifier will review it.' : 'Fix submitted, but the automatic checks flagged it for a closer look.'}
          className="mb-8"
        >
          {assessment.reasons.length > 0 && <ul className="list-disc pl-5">{assessment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </Notification>
      )}
      {wo.blocked && (
        <Notification kind="warning" title="Work is on hold" className="mb-8">
          <p>{wo.blocked.reason}</p>
          <p className="mt-1">Next step: {wo.blocked.nextAction}</p>
        </Notification>
      )}
      {wo.reviewRequired.length > 0 && (
        <div className="mb-8">
          <ReviewReasons reasons={wo.reviewRequired} />
        </div>
      )}

      <div className="grid gap-12 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-8">
          <ActionsCard wo={wo} can={can} onChanged={changed} onAssessment={setAssessment} />
          {wo.complaint && (can('approve') || can('reject_resolution')) && <AnalysisPanel publicId={wo.complaint.publicId} refreshKey={refreshKey} />}
          {wo.complaint && (
            <EvidencePanel
              publicId={wo.complaint.publicId}
              showAuthenticity
              refreshKey={refreshKey}
              uploadPurpose={can('start') || can('block') || can('submit_resolution') ? 'WORK_PROGRESS' : undefined}
              uploadLabel="Take a progress photo or video"
            />
          )}
          <History wo={wo} />
        </div>
        <aside className="flex flex-col gap-6">
          <dl className="grid gap-x-4 gap-y-3 text-[0.875rem] sm:grid-cols-[7rem_1fr]">
            <dt className="text-ink-muted">Complaint</dt>
            <dd>
              {wo.complaint ? <Link to={`${complaintBase}/${encodeURIComponent(wo.complaint.publicId)}`} className="font-mono">{wo.complaint.publicId}</Link> : 'Unavailable'}
            </dd>
            <dt className="text-ink-muted">Department</dt>
            <dd>{wo.department?.name ?? 'None'}</dd>
            <dt className="text-ink-muted">Assignee</dt>
            <dd>{wo.assignee?.name ?? 'Nobody yet'}</dd>
            <dt className="text-ink-muted">Assigned by</dt>
            <dd>{wo.assignmentSource === 'AUTO' ? 'Automatic rules' : wo.assignmentSource === 'MANAGER' ? 'Manager' : wo.assignmentSource === 'ADMIN_OVERRIDE' ? 'Administrator' : '—'}</dd>
            <dt className="text-ink-muted">Due</dt>
            <dd>{wo.dueAt ? formatDateTime(wo.dueAt) : '—'}</dd>
            {wo.complaint?.landmark && (
              <>
                <dt className="text-ink-muted">Landmark</dt>
                <dd>{wo.complaint.landmark}</dd>
              </>
            )}
            {wo.complaint?.location && (
              <>
                <dt className="text-ink-muted">Location</dt>
                <dd>
                  {wo.complaint.address && <span className="block">{wo.complaint.address}</span>}
                  <a href={`https://www.openstreetmap.org/?mlat=${wo.complaint.location.lat}&mlon=${wo.complaint.location.lng}#map=18/${wo.complaint.location.lat}/${wo.complaint.location.lng}`} target="_blank" rel="noreferrer">
                    Open map
                  </a>
                </dd>
              </>
            )}
          </dl>
          {wo.assignmentReason && <p className="text-[0.875rem] text-ink-muted">{wo.assignmentReason}</p>}
          {wo.completionNotes && (
            <div className="text-[0.875rem]">
              <p className="font-semibold">Completion notes</p>
              <p className="whitespace-pre-line text-ink-muted">{wo.completionNotes}</p>
            </div>
          )}
          {wo.verificationDecision && (
            <div className="text-[0.875rem]">
              <p className="font-semibold">Verification decision</p>
              <p className="text-ink-muted">{wo.verificationDecision.decision}{wo.verificationDecision.reason ? `: ${wo.verificationDecision.reason}` : ''}</p>
            </div>
          )}
          <Notes wo={wo} onChanged={changed} />
          <ButtonLink to={back} variant="ghost" className="self-start -ml-4">← Back to work orders</ButtonLink>
        </aside>
      </div>
    </Page>
  );
}

function ActionsCard({ wo, can, onChanged, onAssessment }: { wo: WorkOrder; can: (a: string) => boolean; onChanged: () => void; onAssessment: (a: ResolutionAssessment | null) => void }) {
  const quick = useAction();
  const act = async (action: 'accept' | 'start') => {
    const ok = await quick.run(() => api.workOrderAction(wo.publicId, { action }));
    if (ok) onChanged();
  };
  const verifier = can('approve') || can('reject_resolution');
  const any = ['accept', 'start', 'decline', 'block', 'assign_staff', 'cancel', 'transfer', 'submit_resolution'].some(can) || verifier;

  if (!any) {
    return (
      <Card className="bg-surface-1">
        <p className="text-[0.875rem] text-ink-muted">
          {OPEN.includes(wo.status) ? 'There is nothing for you to do on this work order right now.' : `This work order is ${workOrderStatusMeta(wo.status).label.toLowerCase()}.`}
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-[1.25rem]">What you can do</h2>
      {quick.error && <Notification kind="error" title={quick.error} />}
      <div className="flex flex-wrap items-start gap-3">
        {can('accept') && <Button onClick={() => void act('accept')} disabled={quick.busy}>Accept work</Button>}
        {can('start') && <Button onClick={() => void act('start')} disabled={quick.busy}>{wo.status === 'BLOCKED' ? 'Resume work' : 'Start work'}</Button>}
        {can('decline') && (
          <ReasonAction label="Decline" onSubmit={async (reason) => { await api.workOrderAction(wo.publicId, { action: 'decline', reason }); onChanged(); }} />
        )}
        {can('block') && (
          <ReasonAction
            label="Put on hold"
            fieldLabel="Why is the work on hold?"
            extraField={{ label: 'What happens next?', minLength: 3 }}
            onSubmit={async (reason, nextAction) => { await api.workOrderAction(wo.publicId, { action: 'block', reason, nextAction }); onChanged(); }}
          />
        )}
        {can('cancel') && (
          <ReasonAction
            label="Cancel work order"
            variant="danger"
            helper="The complaint goes back to triage so it can be routed again."
            onSubmit={async (reason) => { await api.workOrderAction(wo.publicId, { action: 'cancel', reason }); onChanged(); }}
          />
        )}
      </div>
      {can('assign_staff') && wo.department && <AssignStaff wo={wo} onChanged={onChanged} />}
      {can('transfer') && <TransferForm wo={wo} onChanged={onChanged} />}
      {can('submit_resolution') && <ResolutionForm wo={wo} onSubmitted={(a) => { onAssessment(a); onChanged(); }} />}
      {verifier && <VerificationForm wo={wo} onChanged={onChanged} />}
    </Card>
  );
}

function AssignStaff({ wo, onChanged }: { wo: WorkOrder; onChanged: () => void }) {
  const members = useResource((signal) => api.listDepartmentMembers(wo.department!.id, signal), [wo.department?.id]);
  const [assigneeId, setAssigneeId] = useState('');
  const { busy, error, run } = useAction();
  const options = (members.data ?? []).filter((m) => m.status === 'ACTIVE');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!assigneeId) return;
    const ok = await run(() => api.workOrderAction(wo.publicId, { action: 'assign', assigneeId }));
    if (ok) onChanged();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-hairline pt-4" noValidate>
      <h3 className="font-semibold">{wo.assignee ? 'Reassign to another team member' : 'Assign a team member'}</h3>
      {members.error && <Notification kind="error" title={members.error} />}
      {error && <Notification kind="error" title={error} />}
      <Select label="Team member" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!members.data}>
        <option value="">{members.loading ? 'Loading team…' : 'Choose a person'}</option>
        {options.map((m) => (
          <option key={m.id} value={m.user.id}>{m.user.name}{m.role === 'MANAGER' ? ' (manager)' : ''}</option>
        ))}
      </Select>
      <Button type="submit" size="sm" disabled={busy || !assigneeId} className="self-start">{busy ? 'Assigning…' : 'Assign'}</Button>
    </form>
  );
}

function TransferForm({ wo, onChanged }: { wo: WorkOrder; onChanged: () => void }) {
  const departments = useResource((signal) => api.listDepartments(signal), []);
  const [departmentId, setDepartmentId] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!departmentId || reason.trim().length < 3) return;
    const ok = await run(() => api.workOrderAction(wo.publicId, { action: 'transfer', departmentId, reason: reason.trim() }));
    if (ok) onChanged();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-hairline pt-4" noValidate>
      <h3 className="font-semibold">Transfer to another department</h3>
      {error && <Notification kind="error" title={error} />}
      <Select label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
        <option value="">Choose a department</option>
        {(departments.data ?? []).filter((d) => d.id !== wo.department?.id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </Select>
      <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      <Button type="submit" size="sm" variant="tertiary" disabled={busy || !departmentId || reason.trim().length < 3} className="self-start">
        {busy ? 'Transferring…' : 'Transfer'}
      </Button>
    </form>
  );
}

/** Upload resolution photos for this work order, then submit them with completion notes. */
function ResolutionForm({ wo, onSubmitted }: { wo: WorkOrder; onSubmitted: (a: ResolutionAssessment | null) => void }) {
  const [notes, setNotes] = useState('');
  const [uploadedIds, setUploadedIds] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const evidence = useResource((signal) => api.listEvidence(wo.complaint!.publicId, signal), [wo.complaint?.publicId, refreshKey]);
  const { busy, error, setError, run } = useAction();

  // Resolution files uploaded for this work order since it was last submitted (or the ones just uploaded).
  const since = wo.resolutionSubmittedAt ? Date.parse(wo.resolutionSubmittedAt) : 0;
  const candidates = (evidence.data ?? []).filter(
    (e) => e.purpose === 'RESOLUTION' && e.workOrderId === wo.id && (Date.parse(e.createdAt) > since || uploadedIds.includes(e.id)),
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (notes.trim().length < 10) return setError('Describe the work done in at least 10 characters.');
    if (candidates.length === 0) return setError('Upload at least one photo of the completed work.');
    const result = await run(() => api.submitResolution(wo.publicId, notes.trim(), candidates.slice(-10).map((e) => e.id)));
    if (result) onSubmitted(result.assessment);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 border-t border-hairline pt-4" noValidate>
      <div>
        <h3 className="font-semibold">{wo.status === 'VERIFICATION_REQUIRED' ? 'Add evidence and resubmit the fix' : 'Submit the fix for verification'}</h3>
        <p className="mt-1 text-[0.875rem] text-ink-muted">
          Take photos on site after the repair (with location turned on). The fix is checked before the complaint is marked resolved.
        </p>
      </div>
      {error && <Notification kind="error" title={error} />}
      <EvidencePanel
        publicId={wo.complaint!.publicId}
        title={`Resolution photos (${candidates.length} ready)`}
        uploadPurpose="RESOLUTION"
        uploadLabel="Take a resolution photo or video"
        filter={(e) => candidates.some((c) => c.id === e.id)}
        refreshKey={refreshKey}
        onUploaded={(e) => {
          setUploadedIds((ids) => [...ids, e.id]);
          setRefreshKey((k) => k + 1);
        }}
      />
      <TextArea label="What was done?" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} helper="10 to 2000 characters." required />
      <Button type="submit" disabled={busy} className="self-start">{busy ? 'Submitting…' : 'Submit fix'}</Button>
    </form>
  );
}

function VerificationForm({ wo, onChanged }: { wo: WorkOrder; onChanged: () => void }) {
  const [decision, setDecision] = useState<VerificationDecision>('APPROVE');
  const [reason, setReason] = useState('');
  const { busy, error, setError, run } = useAction();
  const allowed: VerificationDecision[] = [
    ...(wo.allowedActions.includes('approve') ? (['APPROVE'] as const) : []),
    ...(wo.allowedActions.includes('reject_resolution') ? (['REJECT'] as const) : []),
    ...(wo.status === 'RESOLUTION_SUBMITTED' ? (['REQUEST_EVIDENCE'] as const) : []),
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) return setError('Give a short reason (at least 3 characters).');
    const ok = await run(() => api.verifyResolution(wo.publicId, decision, reason.trim()));
    if (ok) onChanged();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-hairline pt-4" noValidate>
      <h3 className="font-semibold">Verify the fix</h3>
      <p className="text-[0.875rem] text-ink-muted">Compare the resolution photos with the original report. Approving resolves the citizen's complaint.</p>
      {error && <Notification kind="error" title={error} />}
      <Select label="Decision" value={decision} onChange={(e) => setDecision(e.target.value as VerificationDecision)}>
        {allowed.includes('APPROVE') && <option value="APPROVE">Approve: the problem is fixed</option>}
        {allowed.includes('REJECT') && <option value="REJECT">Reject: send back for rework</option>}
        {allowed.includes('REQUEST_EVIDENCE') && <option value="REQUEST_EVIDENCE">Ask for more evidence</option>}
      </Select>
      <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required />
      <Button type="submit" variant={decision === 'REJECT' ? 'danger' : 'primary'} disabled={busy} className="self-start">
        {busy ? 'Saving…' : 'Record decision'}
      </Button>
    </form>
  );
}

function Notes({ wo, onChanged }: { wo: WorkOrder; onChanged: () => void }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const open = OPEN.includes(wo.status);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const ok = await run(() => api.workOrderAction(wo.publicId, { action: 'notes', text: text.trim() }));
    if (ok) {
      setText('');
      onChanged();
    }
  }

  return (
    <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
      <h2 id="notes-heading" className="text-[1rem] font-semibold">Internal notes</h2>
      {wo.notes.length === 0 ? (
        <p className="text-[0.875rem] text-ink-muted">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-3 text-[0.875rem]">
          {wo.notes.map((n, i) => (
            <li key={`${n.at}-${i}`} className="border-l-2 border-hairline pl-3">
              <p className="whitespace-pre-line">{n.text}</p>
              <p className="text-[0.75rem] text-ink-muted">{n.author?.name ?? 'Staff'} · {formatDateTime(n.at)}</p>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
          {error && <Notification kind="error" title={error} />}
          <TextArea label="Add a note" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} helper="Visible to staff only, never to the citizen." />
          <Button type="submit" size="sm" variant="tertiary" disabled={busy || !text.trim()} className="self-start">{busy ? 'Saving…' : 'Add note'}</Button>
        </form>
      )}
    </section>
  );
}

function History({ wo }: { wo: WorkOrder }) {
  return (
    <section aria-labelledby="wo-history-heading">
      <h2 id="wo-history-heading" className="mb-3 text-[1.25rem]">History</h2>
      <ol className="flex flex-col gap-3 text-[0.875rem]">
        {[...wo.history].reverse().map((h, i) => (
          <li key={`${h.at}-${i}`} className="border-l-2 border-hairline pl-3">
            <p>
              <span className="font-semibold">{h.action.replaceAll('_', ' ')}</span>
              {h.toStatus && <> → {workOrderStatusMeta(h.toStatus).label}</>}
              <span className="text-ink-muted"> · {h.actorType === 'SYSTEM' ? 'automatic' : h.actorType.toLowerCase()}</span>
            </p>
            {h.reason && <p className="text-ink-muted">{h.reason}</p>}
            <p className="text-[0.75rem] text-ink-muted">{formatDateTime(h.at)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
