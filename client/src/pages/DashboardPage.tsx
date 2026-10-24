import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import { useOptionalAuth } from '../auth/AuthContext';
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
import { uniqueComplaints } from '../lib/analytics';
import { useRefreshOnActivity } from '../lib/refresh';

interface DashboardPageProps {
  complaintApi?: ComplaintApi;
}

export function DashboardPage({ complaintApi = api }: DashboardPageProps) {
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const [items, setItems] = useState<Complaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);
  useRefreshOnActivity(refresh);

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
        setItems(uniqueComplaints(list));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          void refreshSession?.();
          return;
        }
        setErrorMessage(complaintLoadErrorMessage(error));
      });
    return () => controller.abort();
  }, [complaintApi, refreshSession, reloadToken]);

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
      <WelcomePanel name={auth?.state.user?.displayName} hasComplaints={complaints.length > 0} />
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

/**
 * Shown once, right after sign-up (navigation state `welcome`). Dismissing it clears the state so a
 * reload or back navigation does not show it again.
 */
function WelcomePanel({ name, hasComplaints }: { name?: string; hasComplaints: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const welcome = (location.state as { welcome?: boolean } | null)?.welcome === true;
  if (!welcome) return null;
  const firstName = name?.trim().split(/\s+/)[0];

  function dismiss() {
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }

  return (
    <section aria-labelledby="welcome-heading" className="mb-10 grid gap-0 border border-hairline md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="bg-primary p-6 text-white md:p-8">
        <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-[#d0e2ff]">Account created</p>
        <h2 id="welcome-heading" className="mt-3 text-[1.75rem] leading-tight text-white">
          Welcome to CivicFix{firstName ? `, ${firstName}` : ''}.
        </h2>
        <p className="mt-3 text-[0.875rem] text-[#d0e2ff]">You are signed in. Here is how to get the most out of your account.</p>
      </div>
      <div className="flex flex-col gap-5 bg-canvas p-6 md:p-8">
        <ol className="flex flex-col gap-4 text-[0.875rem]">
          <li className="grid grid-cols-[2rem_1fr] gap-2">
            <span className="font-mono text-primary">01</span>
            <span><strong className="font-semibold">Report a problem</strong> with a clear title, a map pin and a photo.</span>
          </li>
          <li className="grid grid-cols-[2rem_1fr] gap-2">
            <span className="font-mono text-primary">02</span>
            <span><strong className="font-semibold">Watch your notifications</strong> for review, assignment and work updates.</span>
          </li>
          <li className="grid grid-cols-[2rem_1fr] gap-2">
            <span className="font-mono text-primary">03</span>
            <span><strong className="font-semibold">Confirm the fix</strong> when it is resolved, or dispute it if it is not.</span>
          </li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <ButtonLink to="/citizen/complaints/new" state={null}>{hasComplaints ? 'Report another problem' : 'Report your first problem'}</ButtonLink>
          <button type="button" onClick={dismiss} className="min-h-12 px-4 text-[0.875rem] text-primary hover:bg-surface-1">
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
