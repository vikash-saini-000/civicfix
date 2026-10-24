import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { DepartmentApi, StaffComplaint } from '../api/types';
import { useDepartmentContext } from '../auth/useDepartmentContext';
import { ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { DepartmentContextBar } from '../components/DepartmentContextBar';
import { ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { StatusHistory } from '../components/StatusTracker';
import { ResolutionWorkflowNotice } from '../components/ResolutionWorkflowNotice';
import { PriorityBadge, StatusTag } from '../components/Tag';
import { isUsableComplaintId, complaintLocationLabel } from '../lib/complaints';
import { categoryLabel, formatDateTime, getStatusMeta, isValidGeoPoint } from '../lib/domain';
import { staffLoadErrorMessage } from '../lib/department';

type LoadError = 'invalid' | 'not-found' | 'forbidden' | 'failed';
type DetailState =
  | { id: string; departmentId: string; complaint: StaffComplaint; error: null }
  | { id: string; departmentId: string; complaint: null; error: LoadError };

interface DepartmentComplaintDetailPageProps {
  departmentApi?: DepartmentApi;
}

export function DepartmentComplaintDetailPage({ departmentApi = api }: DepartmentComplaintDetailPageProps) {
  const { complaintId = '' } = useParams<{ complaintId?: string }>();
  const { context, memberships, selectDepartment, hasInvalidRequestedContext } = useDepartmentContext();
  const [state, setState] = useState<DetailState | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!context || !isUsableComplaintId(complaintId)) {
      setState({ id: complaintId, departmentId: context?.departmentId ?? '', complaint: null, error: !isUsableComplaintId(complaintId) ? 'invalid' : 'failed' });
      return;
    }

    let alive = true;
    const controller = new AbortController();
    setState(null);
    departmentApi
      .getDepartmentComplaint(context, complaintId, controller.signal)
      .then((complaint) => {
        if (!alive) return;
        setState(
          complaint
            ? { id: complaintId, departmentId: context.departmentId, complaint, error: null }
            : { id: complaintId, departmentId: context.departmentId, complaint: null, error: 'not-found' },
        );
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setState({ id: complaintId, departmentId: context.departmentId, complaint: null, error: classifyDetailError(error) });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [complaintId, context, departmentApi, reloadToken]);

  if (!context) {
    return (
      <Page title="Department complaint" intro="Department context could not be established safely.">
        <DepartmentContextBar memberships={memberships} selectedDepartmentId={memberships[0]?.departmentId ?? ''} onChange={selectDepartment} />
        <Card className="max-w-xl">
          <h2 className="text-[1.25rem]">Department context unavailable</h2>
          <p className="mt-2 text-ink-muted">
            {hasInvalidRequestedContext ? 'The requested department is not one of your authenticated memberships.' : 'Your account has no usable department context.'}
          </p>
        </Card>
      </Page>
    );
  }

  if (!state || state.id !== complaintId || state.departmentId !== context?.departmentId) {
    return (
      <Page title="Loading department complaint">
        <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
        <LoadingIndicator label="Fetching the staff complaint details" />
      </Page>
    );
  }

  if (state.error) {
    return (
      <Page title="Department complaint unavailable">
        <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
        <div className="max-w-xl">
          <ErrorState
            title={state.error === 'forbidden' ? 'You cannot view this complaint' : state.error === 'not-found' || state.error === 'invalid' ? 'Complaint not found' : 'We could not load this complaint'}
            description={detailErrorDescription(state.error, complaintId)}
            onRetry={state.error === 'failed' || state.error === 'forbidden' ? () => setReloadToken((value) => value + 1) : undefined}
          />
          <ButtonLink to="/department/complaints" variant="ghost" className="mt-4 -ml-4">← Back to department complaints</ButtonLink>
        </div>
      </Page>
    );
  }

  const complaint = state.complaint;
  const statusMeta = getStatusMeta(complaint.status);
  return (
    <Page
      title={complaint.title || 'Department complaint'}
      intro={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-ink">{complaint.publicId}</span>
          <StatusTag status={complaint.status} />
          <PriorityBadge priority={complaint.priority} />
        </span>
      }
    >
      <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
      <div className="mb-8">
        <ResolutionWorkflowNotice status={complaint.status} audience="staff" />
      </div>
      <section aria-labelledby="staff-status-heading" className="mb-12">
        <h2 id="staff-status-heading" className="mb-2 text-[1.25rem]">Current status</h2>
        <p className="mb-6 text-ink-muted" aria-live="polite">{statusMeta.citizenText}</p>
        <Card className="bg-surface-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[0.75rem] tracking-[0.02em] text-ink-muted">Visible to</p>
              <p className="mt-1 font-semibold">{complaint.departmentName}</p>
            </div>
            <p className="text-[0.75rem] text-ink-muted">Updated {formatDateTime(complaint.updatedAt)}</p>
          </div>
        </Card>
      </section>

      <div className="grid gap-12 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="staff-updates-heading">
          <h2 id="staff-updates-heading" className="mb-4 text-[1.25rem]">Available status history</h2>
          <StatusHistory complaint={complaint} />
        </section>
        <section aria-labelledby="staff-details-heading" className="flex flex-col gap-6">
          <h2 id="staff-details-heading" className="text-[1.25rem]">Complaint details</h2>
          <dl className="grid gap-x-4 gap-y-3 text-[0.875rem] sm:grid-cols-[8rem_1fr]">
            <dt className="text-ink-muted">Category</dt>
            <dd>{categoryLabel(complaint.confirmedCategory ?? complaint.selectedCategory)}</dd>
            <dt className="text-ink-muted">Priority</dt>
            <dd><PriorityBadge priority={complaint.priority} /></dd>
            <dt className="text-ink-muted">Reported</dt>
            <dd>{formatDateTime(complaint.createdAt)}</dd>
            <dt className="text-ink-muted">Last updated</dt>
            <dd>{formatDateTime(complaint.updatedAt)}</dd>
            {complaint.photoCount !== undefined && (
              <>
                <dt className="text-ink-muted">Evidence</dt>
                <dd>{complaint.photoCount} attachment{complaint.photoCount === 1 ? '' : 's'} recorded</dd>
              </>
            )}
          </dl>
          <div>
            <h3 className="mb-2 text-[0.875rem] font-semibold">Description</h3>
            <p className="whitespace-pre-line text-[0.875rem]">{complaint.description}</p>
          </div>
          <div>
            <h3 className="mb-2 text-[0.875rem] font-semibold">Location summary</h3>
            <p className="text-[0.875rem] text-ink-muted">{complaintLocationLabel(complaint)}</p>
          </div>
          <ReportedLocation complaint={complaint} />
          <ButtonLink to="/department/complaints" variant="ghost" className="self-start -ml-4">← Back to department complaints</ButtonLink>
        </section>
      </div>
    </Page>
  );
}

function ReportedLocation({ complaint }: { complaint: StaffComplaint }) {
  if (!isValidGeoPoint(complaint.location)) return null;
  return (
    <div>
      <h3 className="mb-2 text-[0.875rem] font-semibold">Reported location</h3>
      <div className="border border-hairline">
        <MapContainer center={[complaint.location.lat, complaint.location.lng]} zoom={16} scrollWheelZoom={false} dragging={false} zoomControl={false} doubleClickZoom={false} touchZoom={false} keyboard={false} className="h-48 w-full" aria-label="Map of the complaint location">
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <CircleMarker center={[complaint.location.lat, complaint.location.lng]} radius={10} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#0f62fe', fillOpacity: 1 }} />
        </MapContainer>
      </div>
    </div>
  );
}

function classifyDetailError(error: unknown): Exclude<LoadError, 'invalid'> {
  if (error instanceof ApiError && error.status === 404) return 'not-found';
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return 'forbidden';
  return 'failed';
}

function detailErrorDescription(error: LoadError, complaintId: string): string {
  if (error === 'invalid') return 'The complaint identifier is not valid.';
  if (error === 'not-found') return `No complaint available for ${complaintId}.`;
  if (error === 'forbidden') return 'The service did not authorize this complaint for your department membership.';
  return staffLoadErrorMessage(new Error('department complaint load failed'));
}
