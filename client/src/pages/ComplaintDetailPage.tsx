import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import { useOptionalAuth } from '../auth/AuthContext';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { Select, TextArea } from '../components/Field';
import { EvidencePanel, ReasonAction } from '../components/Workflow';
import { useAction } from '../lib/useResource';
import { ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { ResolutionWorkflowNotice } from '../components/ResolutionWorkflowNotice';
import { StatusHistory, StatusTracker } from '../components/StatusTracker';
import { StatusTag } from '../components/Tag';
import { isUsableComplaintId } from '../lib/complaints';
import { categoryLabel, formatDateTime, getStatusMeta, isValidGeoPoint, type Complaint } from '../lib/domain';

type LoadError = 'invalid' | 'not-found' | 'forbidden' | 'failed';
type DetailState = { id: string; complaint: Complaint; error: null } | { id: string; complaint: null; error: LoadError };

interface ComplaintDetailPageProps {
  complaintApi?: ComplaintApi;
}

export function ComplaintDetailPage({ complaintApi = api }: ComplaintDetailPageProps) {
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const params = useParams<{ complaintId?: string; publicId?: string }>();
  const complaintId = params.complaintId ?? params.publicId ?? '';
  const navigationState = useLocation().state as { justSubmitted?: boolean; photoUploadFailures?: number } | null;
  const justSubmitted = navigationState?.justSubmitted;
  const photoUploadFailures = navigationState?.photoUploadFailures ?? 0;
  const operations = Boolean(complaintApi.capabilities?.operations);
  const [state, setState] = useState<DetailState | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    if (!isUsableComplaintId(complaintId)) {
      setState({ id: complaintId, complaint: null, error: 'invalid' });
      return () => controller.abort();
    }

    let alive = true;
    let requestInFlight = false;
    let lastRefreshAt = 0;
    let requestController: AbortController | null = null;
    setState(null);

    async function load() {
      const now = Date.now();
      if (!alive || requestInFlight || now - lastRefreshAt < 1000) return;
      lastRefreshAt = now;
      requestInFlight = true;
      const request = new AbortController();
      requestController = request;
      try {
        const complaint = await complaintApi.getComplaint(complaintId, request.signal);
        if (alive) setState(complaint ? { id: complaintId, complaint, error: null } : { id: complaintId, complaint: null, error: 'not-found' });
      } catch (error: unknown) {
        if (!alive || request.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          void refreshSession?.();
          return;
        }
        setState({ id: complaintId, complaint: null, error: classifyDetailError(error) });
      } finally {
        requestInFlight = false;
        requestController = null;
      }
    }

    void load();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(() => refreshWhenVisible(), 30_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      requestController?.abort();
      controller.abort();
    };
  }, [complaintApi, complaintId, refreshSession, reloadToken]);

  if (!state || state.id !== complaintId) {
    return (
      <Page title="Loading complaint details">
        <LoadingIndicator label="Fetching the latest public status" />
      </Page>
    );
  }

  if (state.error) return <DetailError error={state.error} complaintId={complaintId} onRetry={() => setReloadToken((value) => value + 1)} />;

  const complaint = state.complaint;
  const statusMeta = getStatusMeta(complaint.status);
  return (
    <Page
      title={complaint.title || 'Complaint details'}
      intro={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-ink">{complaint.publicId}</span>
          <StatusTag status={complaint.status} />
        </span>
      }
    >
      {justSubmitted && (
        <Notification kind="success" title="Complaint submitted" className="mb-8">
          Your complaint ID is <span className="font-mono font-semibold">{complaint.publicId}</span>. Save it to check progress later.
        </Notification>
      )}

      {justSubmitted && photoUploadFailures > 0 && (
        <Notification kind="warning" title="Some photos were not uploaded" className="mb-8">
          {photoUploadFailures} photo{photoUploadFailures === 1 ? '' : 's'} could not be attached. Your complaint was saved; you can add photos below.
        </Notification>
      )}

      <div className="mb-8">
        <ResolutionWorkflowNotice status={complaint.status} audience="citizen" />
      </div>

      {complaint.status === 'REJECTED' && complaint.rejectionReason && (
        <Notification kind="error" title="Why this complaint was rejected" className="mb-8">
          {complaint.rejectionReason}
        </Notification>
      )}

      {complaint.duplicateOf && (
        <Notification kind="info" title="Linked to an earlier report of the same problem" className="mb-8">
          Your report is being handled together with <span className="font-mono">{complaint.duplicateOf.publicId}</span>. You will still get updates here.
        </Notification>
      )}

      {operations && <CitizenActions complaint={complaint} onChanged={() => setReloadToken((value) => value + 1)} />}

      <section aria-labelledby="progress-heading" className="mb-12">
        <h2 id="progress-heading" className="mb-2 text-[1.25rem]">Current status</h2>
        <p className="mb-6 text-ink-muted" aria-live="polite">{statusMeta.citizenText}</p>
        <StatusTracker complaint={complaint} />
      </section>

      <div className="grid gap-12 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="updates-heading">
          <h2 id="updates-heading" className="mb-4 text-[1.25rem]">Activity history</h2>
          <StatusHistory complaint={complaint} />
        </section>

        <section aria-labelledby="details-heading" className="flex flex-col gap-6">
          <h2 id="details-heading" className="text-[1.25rem]">Complaint details</h2>
          <dl className="grid gap-x-4 gap-y-3 text-[0.875rem] sm:grid-cols-[8rem_1fr]">
            <dt className="text-ink-muted">Category</dt>
            <dd>{categoryLabel(complaint.confirmedCategory ?? complaint.selectedCategory)}</dd>
            <dt className="text-ink-muted">Reported</dt>
            <dd>{formatDateTime(complaint.createdAt)}</dd>
            <dt className="text-ink-muted">Last updated</dt>
            <dd>{formatDateTime(complaint.updatedAt)}</dd>
            {complaint.landmark && (
              <>
                <dt className="text-ink-muted">Landmark</dt>
                <dd>{complaint.landmark}</dd>
              </>
            )}
            {complaint.address && (
              <>
                <dt className="text-ink-muted">Address</dt>
                <dd>{complaint.address}</dd>
              </>
            )}
          </dl>
          <div>
            <h3 className="mb-2 text-[0.875rem] font-semibold">Description</h3>
            <p className="whitespace-pre-line text-[0.875rem]">{complaint.description}</p>
          </div>
          <ReportedLocation complaint={complaint} />
          {operations && (
            <EvidencePanel
              publicId={complaint.publicId}
              uploadPurpose={['CLOSED', 'REJECTED'].includes(complaint.status) ? undefined : 'ADDITIONAL'}
              uploadLabel="Take another photo or video"
            />
          )}
          <ButtonLink to="/citizen/complaints" variant="ghost" className="self-start -ml-4">
            ← Back to my complaints
          </ButtonLink>
        </section>
      </div>
    </Page>
  );
}

function ReportedLocation({ complaint }: { complaint: Complaint }) {
  if (!isValidGeoPoint(complaint.location)) {
    return <p className="text-[0.875rem] text-ink-muted">The reported location is unavailable.</p>;
  }

  return (
    <div>
      <h3 className="mb-2 text-[0.875rem] font-semibold">Reported location</h3>
      <div className="border border-hairline">
        <MapContainer
          center={[complaint.location.lat, complaint.location.lng]}
          zoom={16}
          scrollWheelZoom={false}
          dragging={false}
          zoomControl={false}
          doubleClickZoom={false}
          touchZoom={false}
          keyboard={false}
          className="h-48 w-full"
          aria-label="Map of the complaint location"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <CircleMarker
            center={[complaint.location.lat, complaint.location.lng]}
            radius={10}
            pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#0f62fe', fillOpacity: 1 }}
          />
        </MapContainer>
      </div>
    </div>
  );
}

function DetailError({ error, complaintId, onRetry }: { error: LoadError; complaintId: string; onRetry: () => void }) {
  if (error === 'invalid' || error === 'not-found') {
    return (
      <Page title="Complaint not found">
        <p className="text-ink-muted">
          {error === 'invalid' ? 'The complaint identifier is not valid.' : <>There is no complaint available for <span className="font-mono">{complaintId}</span>.</>}{' '}
          <Link to="/citizen/complaints">Go to My complaints</Link>.
        </p>
      </Page>
    );
  }

  return (
    <Page title="Complaint unavailable">
      <div className="max-w-xl">
        <ErrorState
          title={error === 'forbidden' ? 'You cannot view this complaint' : 'We could not load this complaint'}
          description={error === 'forbidden' ? 'The service did not authorize this complaint for your account.' : 'The complaint service could not be reached. Try again without leaving this page.'}
          onRetry={onRetry}
        />
        <ButtonLink to="/citizen/complaints" variant="ghost" className="mt-4 -ml-4">← Back to my complaints</ButtonLink>
      </div>
    </Page>
  );
}

function classifyDetailError(error: unknown): Exclude<LoadError, 'invalid'> {
  if (error instanceof ApiError && error.status === 404) return 'not-found';
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return 'forbidden';
  return 'failed';
}

/** Follow-up answers and the steps a citizen can take after a fix (docs/api/EVIDENCE_VERIFICATION_DISPUTES.md). */
function CitizenActions({ complaint, onChanged }: { complaint: Complaint; onChanged: () => void }) {
  const canAnswer = complaint.allowedActions?.includes('answer_follow_up') && complaint.followUp && !complaint.followUp.answeredAt;
  const resolved = complaint.status === 'RESOLVED';
  if (!canAnswer && !resolved) return null;
  return (
    <div className="mb-12 flex flex-col gap-6">
      {canAnswer && complaint.followUp && <FollowUpForm publicId={complaint.publicId} questions={complaint.followUp.questions} onDone={onChanged} />}
      {resolved && <ResolvedActions publicId={complaint.publicId} onDone={onChanged} />}
    </div>
  );
}

function FollowUpForm({ publicId, questions, onDone }: { publicId: string; questions: string[]; onDone: () => void }) {
  const [answers, setAnswers] = useState(() => questions.map(() => ''));
  const { busy, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(async () => {
      await api.answerFollowUp(publicId, answers.map((a) => a.trim()));
      return true;
    });
    if (ok) onDone();
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h2 className="text-[1.25rem]">The team has a few questions</h2>
          <p className="mt-1 text-[0.875rem] text-ink-muted">Your answers help route the complaint to the right team. Leave a box empty to skip a question.</p>
        </div>
        {error && <Notification kind="error" title={error} />}
        {questions.map((question, index) => (
          <TextArea
            key={question}
            label={question}
            value={answers[index] ?? ''}
            maxLength={500}
            onChange={(e) => setAnswers((current) => current.map((value, i) => (i === index ? e.target.value : value)))}
          />
        ))}
        <Button type="submit" disabled={busy} className="self-start">{busy ? 'Sending…' : 'Send answers'}</Button>
      </form>
    </Card>
  );
}

type DisputeCategory = 'NOT_FIXED' | 'POOR_QUALITY' | 'WRONG_LOCATION' | 'OTHER';

function ResolvedActions({ publicId, onDone }: { publicId: string; onDone: () => void }) {
  const close = useAction();
  const feedback = useAction();
  const [rating, setRating] = useState('5');
  const [comment, setComment] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [category, setCategory] = useState<DisputeCategory>('NOT_FIXED');

  async function sendFeedback(event: FormEvent) {
    event.preventDefault();
    const ok = await feedback.run(async () => {
      await api.sendFeedback(publicId, { rating: Number(rating), ...(comment.trim() ? { comment: comment.trim() } : {}) });
      return true;
    });
    if (ok) setFeedbackSent(true);
  }

  async function confirmFixed() {
    const ok = await close.run(async () => {
      await api.closeComplaint(publicId);
      return true;
    });
    if (ok) onDone();
  }

  return (
    <Card className="flex flex-col gap-6">
      <div>
        <h2 className="text-[1.25rem]">Is the problem fixed?</h2>
        <p className="mt-1 text-[0.875rem] text-ink-muted">
          The team's fix was checked and approved. Confirm it to close the complaint, or tell us if it is not fixed.
        </p>
      </div>
      {close.error && <Notification kind="error" title={close.error} />}
      <div className="flex flex-wrap items-start gap-6">
        <Button disabled={close.busy} onClick={() => void confirmFixed()}>
          {close.busy ? 'Closing…' : 'Yes, it is fixed. Close it'}
        </Button>
        <div className="flex min-w-[16rem] flex-1 flex-col gap-3">
          <Select label="If not, what is wrong?" value={category} onChange={(e) => setCategory(e.target.value as DisputeCategory)}>
            <option value="NOT_FIXED">It is not fixed</option>
            <option value="POOR_QUALITY">The repair is poor</option>
            <option value="WRONG_LOCATION">The wrong place was fixed</option>
            <option value="OTHER">Something else</option>
          </Select>
          <ReasonAction
            label="Dispute the fix"
            fieldLabel="What is still wrong?"
            minLength={10}
            helper="At least 10 characters. A manager will review it."
            onSubmit={async (reason) => {
              await api.disputeComplaint(publicId, { reason, category });
              onDone();
            }}
          />
        </div>
      </div>
      {feedbackSent ? (
        <Notification kind="success" title="Thank you for your feedback" />
      ) : (
        <form onSubmit={sendFeedback} className="flex flex-col gap-3 border-t border-hairline pt-6" noValidate>
          <h3 className="text-[1rem] font-semibold">Rate the service (optional)</h3>
          {feedback.error && <Notification kind="error" title={feedback.error} />}
          <Select label="Rating" value={rating} onChange={(e) => setRating(e.target.value)} className="max-w-xs">
            <option value="5">5 (excellent)</option>
            <option value="4">4 (good)</option>
            <option value="3">3 (okay)</option>
            <option value="2">2 (poor)</option>
            <option value="1">1 (very poor)</option>
          </Select>
          <TextArea label="Comment" optional value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
          <Button type="submit" variant="tertiary" size="sm" disabled={feedback.busy} className="self-start">
            {feedback.busy ? 'Sending…' : 'Send feedback'}
          </Button>
        </form>
      )}
    </Card>
  );
}
