import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import type { ComplaintApi } from '../api/types';
import { ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { StatusTag } from '../components/Tag';
import {
  complaintLoadErrorMessage,
  complaintLocationLabel,
  complaintStatusOptions,
  countComplaintsByStatus,
  sortComplaints,
} from '../lib/complaints';
import { categoryLabel, formatDateTime, getStatusMeta, type Complaint } from '../lib/domain';

interface DashboardPageProps {
  complaintApi?: ComplaintApi;
}

export function DashboardPage({ complaintApi = api }: DashboardPageProps) {
  const [items, setItems] = useState<Complaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setErrorMessage(null);
    complaintApi
      .listMyComplaints(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(list)) {
          setErrorMessage('The complaint service returned an unexpected response. Please try again.');
          return;
        }
        setItems(list);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setErrorMessage(complaintLoadErrorMessage(error));
      });
    return () => controller.abort();
  }, [complaintApi, reloadToken]);

  const recent = useMemo(() => (items ? sortComplaints(items, 'updated-desc').slice(0, 3) : []), [items]);

  if (!items && !errorMessage) {
    return (
      <Page title="Citizen dashboard" intro="A clear view of the civic issues you have reported.">
        <LoadingIndicator label="Loading your complaint summary" />
      </Page>
    );
  }

  if (errorMessage) {
    return (
      <Page title="Citizen dashboard" intro="A clear view of the civic issues you have reported.">
        <div className="max-w-xl">
          <ErrorState title="We could not load your dashboard" description={errorMessage} onRetry={() => setReloadToken((value) => value + 1)} />
        </div>
      </Page>
    );
  }

  const complaints = items ?? [];
  const statusOptions = complaintStatusOptions(complaints);
  return (
    <Page
      title="Citizen dashboard"
      intro="See what is happening with the civic issues you have reported."
      actions={<ButtonLink to="/citizen/complaints/new">Report an issue</ButtonLink>}
    >
      <div className="flex flex-col gap-10">
        <section aria-labelledby="summary-heading">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="summary-heading" className="text-[1.25rem]">Your complaint summary</h2>
              <p className="mt-1 text-[0.875rem] text-ink-muted">Counts are calculated from your authorized complaint list.</p>
            </div>
            <Link to="/citizen/complaints" className="text-[0.875rem] font-semibold">View all complaints</Link>
          </div>
          <div className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard label="Total complaints" value={complaints.length} />
            {statusOptions.map((status) => (
              <MetricCard key={status} label={getStatusMeta(status).label} value={countComplaintsByStatus(complaints, status)} />
            ))}
          </div>
        </section>

        {complaints.length === 0 ? (
          <Card>
            <EmptyState
              title="No complaints yet"
              description="You have not submitted a civic issue yet. Report one to start following its progress."
              action={<ButtonLink to="/citizen/complaints/new">Report an issue</ButtonLink>}
            />
          </Card>
        ) : (
          <section aria-labelledby="recent-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="recent-heading" className="text-[1.25rem]">Recent complaints</h2>
                <p className="mt-1 text-[0.875rem] text-ink-muted">The complaints with the latest reported activity.</p>
              </div>
              <Link to="/citizen/complaints" className="text-[0.875rem] font-semibold">View my complaints</Link>
            </div>
            <ul className="border-t border-hairline">
              {recent.map((complaint) => <RecentComplaint key={complaint.publicId} complaint={complaint} />)}
            </ul>
          </section>
        )}
      </div>
    </Page>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="border-0 bg-canvas">
      <p className="text-[0.75rem] text-ink-muted">{label}</p>
      <p className="mt-2 text-[2rem] leading-none font-semibold" aria-label={`${label}: ${value}`}>{value}</p>
    </Card>
  );
}

function RecentComplaint({ complaint }: { complaint: Complaint }) {
  return (
    <li className="border-b border-hairline">
      <Link
        to={`/citizen/complaints/${encodeURIComponent(complaint.publicId)}`}
        className="grid gap-3 px-4 py-4 no-underline text-ink transition-colors hover:bg-surface-1 md:grid-cols-[1fr_auto] md:items-center"
      >
        <div className="min-w-0">
          <p className="font-mono text-[0.75rem] text-ink-muted">{complaint.publicId}</p>
          <p className="truncate font-semibold">{complaint.title}</p>
          <p className="text-[0.875rem] text-ink-muted">
            {categoryLabel(complaint.confirmedCategory ?? complaint.selectedCategory)} · {complaintLocationLabel(complaint)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:justify-end">
          <StatusTag status={complaint.status} />
          <span className="text-[0.75rem] text-ink-muted">Updated {formatDateTime(complaint.updatedAt)}</span>
        </div>
      </Link>
    </li>
  );
}
