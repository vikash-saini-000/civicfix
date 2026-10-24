import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet';
import { api } from '../api';
import { ButtonLink } from '../components/Button';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { StatusHistory, StatusTracker } from '../components/StatusTracker';
import { PriorityBadge, StatusTag } from '../components/Tag';
import { STATUS_META, categoryLabel, formatDateTime, type Complaint } from '../lib/domain';

const POLL_MS = 5000;

export function ComplaintDetailPage() {
  const { publicId = '' } = useParams();
  const justSubmitted = (useLocation().state as { justSubmitted?: boolean } | null)?.justSubmitted;
  const [complaint, setComplaint] = useState<Complaint | null | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getComplaint(publicId)
        .then((c) => {
          if (alive) {
            setComplaint(c);
            setError(false);
          }
        })
        .catch(() => alive && setError(true));
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [publicId]);

  if (complaint === undefined && !error) {
    return (
      <Page title="Loading complaint…">
        <p className="text-ink-muted" aria-busy="true">
          Fetching the latest status.
        </p>
      </Page>
    );
  }

  if (!complaint) {
    return (
      <Page title="Complaint not found">
        {error ? (
          <Notification kind="error" title="We could not load this complaint. Refresh the page to try again." />
        ) : (
          <p className="text-ink-muted">
            There is no complaint with ID <span className="font-mono">{publicId}</span>. Check the ID or go to{' '}
            <Link to="/complaints">My complaints</Link>.
          </p>
        )}
      </Page>
    );
  }

  const c = complaint;
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
      {justSubmitted && (
        <Notification kind="success" title="Complaint submitted" className="mb-8">
          Your complaint ID is <span className="font-mono font-semibold">{c.publicId}</span>. Save it to check progress later.
        </Notification>
      )}

      <section aria-labelledby="progress-h" className="mb-12">
        <h2 id="progress-h" className="text-[1.25rem] mb-2">
          Progress
        </h2>
        <p className="text-ink-muted mb-6" aria-live="polite">
          {STATUS_META[c.status].citizenText}
        </p>
        <StatusTracker complaint={c} />
      </section>

      <div className="grid gap-12 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="history-h">
          <h2 id="history-h" className="text-[1.25rem] mb-4">
            Updates
          </h2>
          <StatusHistory complaint={c} />
        </section>

        <section aria-labelledby="details-h" className="flex flex-col gap-6">
          <h2 id="details-h" className="text-[1.25rem]">
            Details
          </h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-[0.875rem]">
            <dt className="text-ink-muted">Category</dt>
            <dd>
              {categoryLabel(c.confirmedCategory ?? c.selectedCategory)}
              {!c.confirmedCategory && <span className="text-ink-muted"> (to be confirmed)</span>}
            </dd>
            <dt className="text-ink-muted">Department</dt>
            <dd>{c.department ?? <span className="text-ink-muted">Not assigned yet</span>}</dd>
            <dt className="text-ink-muted">Reported</dt>
            <dd>{formatDateTime(c.createdAt)}</dd>
            <dt className="text-ink-muted">Photos</dt>
            <dd>{c.photoCount}</dd>
            {c.landmark && (
              <>
                <dt className="text-ink-muted">Landmark</dt>
                <dd>{c.landmark}</dd>
              </>
            )}
          </dl>
          <div>
            <h3 className="text-[0.875rem] font-semibold mb-2">Description</h3>
            <p className="text-[0.875rem] whitespace-pre-line">{c.description}</p>
          </div>
          <div className="border border-hairline">
            <MapContainer
              center={[c.location.lat, c.location.lng]}
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
                center={[c.location.lat, c.location.lng]}
                radius={10}
                pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#0f62fe', fillOpacity: 1 }}
              />
            </MapContainer>
          </div>
          <ButtonLink to="/complaints" variant="ghost" className="self-start -ml-4">
            ← Back to my complaints
          </ButtonLink>
        </section>
      </div>
    </Page>
  );
}
