import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import type { StaffComplaint } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../components/Badge';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingIndicator } from '../components/Feedback';
import { Select, TextArea } from '../components/Field';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { PriorityBadge, StatusTag } from '../components/Tag';
import { AnalysisPanel, EvidencePanel, ReasonAction, ReviewReasons } from '../components/Workflow';
import { CATEGORIES, PRIORITY_META, categoryLabel, formatDateTime, type Priority } from '../lib/domain';
import { useRefreshOnActivity } from '../lib/refresh';
import { useAction, useResource } from '../lib/useResource';

/** GET /assignments/queue: complaints waiting for a routing decision (managers: their departments; admins: all). */
export function ManagerReviewPage() {
  const { state } = useAuth();
  const isAdmin = state.user?.role === 'platform_admin';
  const base = isAdmin ? '/admin/triage' : '/manager/review';
  const queue = useResource((signal) => api.listReviewQueue(signal), []);
  useRefreshOnActivity(queue.reload);

  return (
    <Page
      title={isAdmin ? 'Triage queue' : 'Complaint review'}
      intro="Reports the automatic rules could not route on their own. Check the AI suggestion, then route, assign or reject."
      actions={<Button variant="tertiary" onClick={queue.reload}>Refresh</Button>}
    >
      {queue.loading && !queue.data && <LoadingIndicator label="Loading the review queue" />}
      {queue.error && <ErrorState title="We could not load the review queue" description={queue.error} onRetry={queue.reload} />}
      {queue.data && queue.data.length === 0 && (
        <Card>
          <EmptyState title="The queue is empty" description="Every report has been routed. New ones appear here when they need a human decision." />
        </Card>
      )}
      {queue.data && queue.data.length > 0 && (
        <ul className="border-t border-hairline" aria-label="Complaints waiting for review">
          {queue.data.map((item) => (
            <li key={item.publicId} className="border-b border-hairline">
              <Link to={`${base}/${encodeURIComponent(item.publicId)}`} className="grid gap-3 px-4 py-4 text-ink no-underline hover:bg-surface-1 md:grid-cols-[1fr_auto] md:items-center">
                <div className="min-w-0">
                  <p className="font-mono text-[0.75rem] text-ink-muted">{item.publicId} · reported {formatDateTime(item.createdAt)}</p>
                  <p className="truncate font-semibold">{item.title}</p>
                  <p className="text-[0.875rem] text-ink-muted">
                    {categoryLabel(item.category)} · {item.department?.name ?? (item.suggestedDepartment ? `AI suggests ${item.suggestedDepartment.name}` : 'No department yet')}
                    {item.linkedReportCount > 0 && ` · ${item.linkedReportCount} linked report${item.linkedReportCount === 1 ? '' : 's'}`}
                  </p>
                  <div className="mt-2"><ReviewReasons reasons={item.reviewReasons} /></div>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  {item.awaitingCitizen && <Badge tone="neutral">Waiting for citizen</Badge>}
                  {item.spamScore >= 0.5 && <Badge tone="warning">Possible spam</Badge>}
                  <PriorityBadge priority={item.priority} />
                  <StatusTag status={item.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

export function ManagerReviewDetailPage() {
  const { complaintId = '' } = useParams<{ complaintId?: string }>();
  const { state } = useAuth();
  const isAdmin = state.user?.role === 'platform_admin';
  const back = isAdmin ? '/admin/triage' : '/manager/review';
  const [refreshKey, setRefreshKey] = useState(0);
  const complaint = useResource(
    (signal) => api.getDepartmentComplaint({ departmentId: '', membershipRole: 'manager' }, complaintId, signal),
    [complaintId, refreshKey],
  );

  if (complaint.loading && !complaint.data) {
    return (
      <Page title="Loading complaint">
        <LoadingIndicator label="Loading complaint" />
      </Page>
    );
  }
  if (complaint.error || !complaint.data) {
    return (
      <Page title="Complaint unavailable">
        <div className="max-w-xl">
          <ErrorState title="We could not load this complaint" description={complaint.error ?? `No complaint ${complaintId} is visible to you.`} onRetry={complaint.error ? complaint.reload : undefined} />
          <ButtonLink to={back} variant="ghost" className="mt-4 -ml-4">← Back to the queue</ButtonLink>
        </div>
      </Page>
    );
  }

  const c = complaint.data;
  const inTriage = c.status === 'REPORTED' || c.status === 'UNDER_REVIEW';
  return (
    <Page
      title={c.title}
      intro={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-ink">{c.publicId}</span>
          <StatusTag status={c.status} />
          <PriorityBadge priority={c.priority} />
        </span>
      }
    >
      {c.spamCheck && c.spamCheck.score >= 0.5 && (
        <Notification kind="warning" title="This report looks like possible spam" className="mb-8">
          Signals: {c.spamCheck.signals.join(', ') || 'none listed'}. Nothing is rejected automatically; you decide.
        </Notification>
      )}
      {c.followUp && !c.followUp.answeredAt && (
        <Notification kind="info" title="Waiting for the citizen to answer follow-up questions" className="mb-8">
          <ul className="list-disc pl-5">{c.followUp.questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </Notification>
      )}
      {c.followUp?.answeredAt && (
        <Notification kind="info" title="The citizen answered the follow-up questions" className="mb-8">
          <dl className="grid gap-1">
            {c.followUp.questions.map((q, i) => (
              <div key={q}>
                <dt className="font-semibold">{q}</dt>
                <dd>{c.followUp!.answers[i] || <span className="text-ink-muted">(skipped)</span>}</dd>
              </div>
            ))}
          </dl>
        </Notification>
      )}

      <div className="grid gap-12 lg:grid-cols-[1fr_24rem]">
        <div className="flex flex-col gap-8">
          <section aria-labelledby="report-heading">
            <h2 id="report-heading" className="mb-3 text-[1.25rem]">Citizen's report</h2>
            <p className="whitespace-pre-line">{c.description}</p>
            <dl className="mt-4 grid gap-x-4 gap-y-2 text-[0.875rem] sm:grid-cols-[9rem_1fr]">
              <dt className="text-ink-muted">Citizen's category</dt>
              <dd>{categoryLabel(c.selectedCategory)}</dd>
              <dt className="text-ink-muted">Department</dt>
              <dd>{c.departmentName}</dd>
              {c.landmark && (<><dt className="text-ink-muted">Landmark</dt><dd>{c.landmark}</dd></>)}
              <dt className="text-ink-muted">Reporter</dt>
              <dd>{c.reporterAlias ?? 'Hidden'}</dd>
              <dt className="text-ink-muted">Location</dt>
              <dd>
                {c.address && <span className="block">{c.address}</span>}
                <a href={`https://www.openstreetmap.org/?mlat=${c.location.lat}&mlon=${c.location.lng}#map=18/${c.location.lat}/${c.location.lng}`} target="_blank" rel="noreferrer">
                  {c.location.lat.toFixed(5)}, {c.location.lng.toFixed(5)}
                </a>
              </dd>
            </dl>
          </section>
          <AnalysisPanel publicId={c.publicId} refreshKey={refreshKey} />
          <EvidencePanel publicId={c.publicId} showAuthenticity />
        </div>
        <aside className="flex flex-col gap-6">
          {inTriage ? (
            <>
              <RoutingForm complaint={c} isAdmin={isAdmin} back={back} />
              {c.allowedActions?.includes('reject') && (
                <Card className="flex flex-col gap-3">
                  <h2 className="text-[1.125rem]">Reject</h2>
                  <p className="text-[0.875rem] text-ink-muted">Only when the report can't be acted on. The reason is shown to the citizen.</p>
                  <ReasonAction
                    label="Reject complaint"
                    variant="danger"
                    minLength={5}
                    fieldLabel="Reason (shown to the citizen)"
                    onSubmit={async (reason) => {
                      await api.rejectComplaint(c.publicId, reason);
                      setRefreshKey((k) => k + 1);
                    }}
                  />
                </Card>
              )}
            </>
          ) : (
            <Card className="bg-surface-1">
              <p className="text-[0.875rem]">This complaint is no longer waiting for routing.</p>
            </Card>
          )}
          <ButtonLink to={back} variant="ghost" className="self-start -ml-4">← Back to the queue</ButtonLink>
        </aside>
      </div>
    </Page>
  );
}

/**
 * POST /complaints/:id/assign creates the work order (department, priority, optional assignee).
 * Admins can also just route with /classify and leave assignment to the department manager.
 */
function RoutingForm({ complaint, isAdmin, back }: { complaint: StaffComplaint; isAdmin: boolean; back: string }) {
  const navigate = useNavigate();
  const { state } = useAuth();
  const departments = useResource((signal) => api.listDepartments(signal), []);
  const analysis = useResource((signal) => api.getAnalysis(complaint.publicId, signal).catch(() => null), [complaint.publicId]);
  const suggestion = analysis.data?.classification.status === 'SUCCEEDED' ? analysis.data.classification.suggestion : null;

  const managed = useMemo(
    () => new Set((state.user?.departmentMemberships ?? []).filter((m) => m.role === 'manager').map((m) => m.departmentId)),
    [state.user],
  );
  const [departmentId, setDepartmentId] = useState(complaint.departmentId ?? '');
  const [category, setCategory] = useState<string>(complaint.confirmedCategory ?? complaint.selectedCategory ?? '');
  const [priority, setPriority] = useState<string>(complaint.priority ?? '');
  const [assigneeId, setAssigneeId] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'assign' | 'route'>('assign');
  const { busy, error, setError, run } = useAction();

  // Prefill from the AI suggestion once it arrives; the human can change everything.
  useEffect(() => {
    if (!suggestion) return;
    setCategory((v) => v || suggestion.category || '');
    setPriority((v) => v || suggestion.priority || '');
    setDepartmentId((v) => v || (suggestion.department && (isAdmin || managed.has(suggestion.department.id)) ? suggestion.department.id : ''));
  }, [isAdmin, managed, suggestion]);

  const departmentOptions = (departments.data ?? []).filter(
    (d) => d.isActive && (isAdmin || managed.has(d.id)) && (!category || d.categories.includes(category as never)),
  );
  const canListMembers = Boolean(departmentId) && (isAdmin || managed.has(departmentId));
  const members = useResource(canListMembers ? (signal) => api.listDepartmentMembers(departmentId, signal) : null, [departmentId, canListMembers]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!departmentId || !category) return setError('Choose a category and a department.');
    if (mode === 'assign') {
      if (!priority) return setError('Choose a priority.');
      if (reason.trim().length < 3) return setError('Give a short reason for this decision (at least 3 characters).');
      const wo = await run(() =>
        api.assignComplaint(complaint.publicId, { departmentId, category, priority, assigneeId: assigneeId || undefined, reason: reason.trim() }),
      );
      if (wo) navigate(`/work-orders/${encodeURIComponent(wo.publicId)}`);
    } else {
      const ok = await run(async () => {
        await api.classifyComplaint(complaint.publicId, { departmentId, category, priority: priority || undefined, note: reason.trim() || undefined });
        return true;
      });
      if (ok) navigate(back);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h2 className="text-[1.125rem]">Your decision</h2>
        {isAdmin && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Decision type">
            <Button size="sm" variant={mode === 'assign' ? 'primary' : 'tertiary'} aria-pressed={mode === 'assign'} onClick={() => setMode('assign')}>Create work order</Button>
            <Button size="sm" variant={mode === 'route' ? 'primary' : 'tertiary'} aria-pressed={mode === 'route'} onClick={() => setMode('route')}>Route only</Button>
          </div>
        )}
        {mode === 'route' && <p className="text-[0.875rem] text-ink-muted">Sends the complaint to the department; its manager assigns the work.</p>}
        {error && <Notification kind="error" title={error} />}
        {departments.error && <Notification kind="error" title={departments.error} />}
        <Select label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setDepartmentId(''); }}>
          <option value="">Choose a category</option>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}{suggestion?.category === c.id ? ' (AI suggestion)' : ''}</option>)}
        </Select>
        <Select label="Department" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setAssigneeId(''); }} helper={!isAdmin ? 'Managers can route only to their own department.' : undefined}>
          <option value="">{departments.loading ? 'Loading departments…' : 'Choose a department'}</option>
          {departmentOptions.map((d) => <option key={d.id} value={d.id}>{d.name}{suggestion?.department?.id === d.id ? ' (AI suggestion)' : ''}</option>)}
        </Select>
        <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)} optional={mode === 'route'}>
          <option value="">Choose a priority</option>
          {(Object.keys(PRIORITY_META) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}{suggestion?.priority === p ? ' (AI suggestion)' : ''}</option>)}
        </Select>
        {mode === 'assign' && (
          <Select label="Assign to" optional value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!members.data} helper="Leave empty to let the department pick.">
            <option value="">{members.loading ? 'Loading team…' : 'Nobody yet'}</option>
            {(members.data ?? []).filter((m) => m.status === 'ACTIVE').map((m) => <option key={m.id} value={m.user.id}>{m.user.name}{m.role === 'MANAGER' ? ' (manager)' : ''}</option>)}
          </Select>
        )}
        <TextArea
          label={mode === 'assign' ? 'Reason for this decision' : 'Note for the citizen'}
          optional={mode === 'route'}
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
          helper={mode === 'assign' ? 'Saved in the audit trail.' : 'Shown to the citizen. Leave empty for the default message.'}
        />
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : mode === 'assign' ? 'Create work order' : 'Route complaint'}</Button>
      </form>
    </Card>
  );
}
