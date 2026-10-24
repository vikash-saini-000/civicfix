import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import { ButtonLink } from '../components/Button';
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
  const params = useParams<{ complaintId?: string; publicId?: string }>();
  const complaintId = params.complaintId ?? params.publicId ?? '';
  const justSubmitted = (useLocation().state as { justSubmitted?: boolean } | null)?.justSubmitted;
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
    let requestController: AbortController | null = null;
    setState(null);

    async function load() {
      if (!alive || requestInFlight) return;
      requestInFlight = true;
      const request = new AbortController();
      requestController = request;
      try {
        const complaint = await complaintApi.getComplaint(complaintId, request.signal);
        if (alive) setState(complaint ? { id: complaintId, complaint, error: null } : { id: complaintId, complaint: null, error: 'not-found' });
      } catch (error: unknown) {
        if (!alive || request.signal.aborted) return;
        setState({ id: complaintId, complaint: null, error: classifyDetailError(error) });
      } finally {
        requestInFlight = false;
        requestController = null;
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      requestController?.abort();
      controller.abort();
    };
  }, [complaintApi, complaintId, reloadToken]);

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

      <div className="mb-8">
        <ResolutionWorkflowNotice status={complaint.status} audience="citizen" />
      </div>

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
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-[0.875rem]">
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
          </dl>
          <div>
            <h3 className="mb-2 text-[0.875rem] font-semibold">Description</h3>
            <p className="whitespace-pre-line text-[0.875rem]">{complaint.description}</p>
          </div>
          <ReportedLocation complaint={complaint} />
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
