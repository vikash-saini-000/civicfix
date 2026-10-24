import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { DepartmentApi, StaffComplaint } from '../api/types';
import { useAuth, useOptionalAuth } from '../auth/AuthContext';
import { useDepartmentContext } from '../auth/useDepartmentContext';
import { DepartmentContextBar } from '../components/DepartmentContextBar';
import { ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { StatusTag } from '../components/Tag';
import { complaintLocationLabel, sortComplaints } from '../lib/complaints';
import { categoryLabel, formatDateTime, getStatusMeta } from '../lib/domain';
import { staffLoadErrorMessage } from '../lib/department';
import { buildComplaintAnalytics, uniqueComplaints } from '../lib/analytics';
import { useRefreshOnActivity } from '../lib/refresh';

interface DepartmentWorkspacePageProps {
  departmentApi?: DepartmentApi;
}

export function DepartmentWorkspacePage({ departmentApi = api }: DepartmentWorkspacePageProps) {
  const { state } = useAuth();
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const { context, memberships, selectDepartment, hasInvalidRequestedContext } = useDepartmentContext();
  const [items, setItems] = useState<StaffComplaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);
  useRefreshOnActivity(refresh, { enabled: Boolean(context) });

  useEffect(() => {
    if (!context) {
      setItems(null);
      setErrorMessage(hasInvalidRequestedContext ? 'The selected department is not part of your authenticated memberships.' : null);
      return;
    }

    const controller = new AbortController();
    setItems(null);
    setErrorMessage(null);
    departmentApi
      .listDepartmentComplaints(context, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        if (Array.isArray(list)) setItems(list);
        else setErrorMessage('The department complaint service returned an unexpected response. Please try again.');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          void refreshSession?.();
          return;
        }
        setErrorMessage(staffLoadErrorMessage(error));
      });
    return () => controller.abort();
  }, [context, departmentApi, hasInvalidRequestedContext, refreshSession, reloadToken]);

  const uniqueStaffComplaints = useMemo(() => uniqueComplaints(items ?? []), [items]);
  const analytics = useMemo(() => buildComplaintAnalytics(uniqueStaffComplaints), [uniqueStaffComplaints]);
  const recent = useMemo(() => sortComplaints(uniqueStaffComplaints, 'updated-desc').slice(0, 5), [uniqueStaffComplaints]);
  const heading = context?.departmentName ?? context?.departmentId ?? 'Department workspace';

  if (!context) {
    return (
      <Page title="Department workspace" intro="Department context could not be established safely.">
        <Card className="max-w-xl">
          <h2 className="text-[1.25rem]">Department context unavailable</h2>
          <p className="mt-2 text-ink-muted">
            {hasInvalidRequestedContext
              ? 'The requested department is not one of your authenticated memberships.'
              : state.user?.departmentMemberships?.length
                ? 'Choose a department from your authenticated memberships.'
                : 'Your account has no department membership.'}
          </p>
        </Card>
      </Page>
    );
  }

  if (!items && !errorMessage) {
    return (
      <Page title={`${heading} workspace`} intro="Review complaints visible to your authenticated department membership.">
        <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
        <LoadingIndicator label="Loading department complaints" />
      </Page>
    );
  }

  if (errorMessage) {
    return (
      <Page title={`${heading} workspace`} intro="Review complaints visible to your authenticated department membership.">
        <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
        <div className="max-w-xl">
          <ErrorState title="We could not load the department workspace" description={errorMessage} onRetry={() => setReloadToken((value) => value + 1)} />
        </div>
      </Page>
    );
  }

  const complaints = analytics.items;
  const statusOptions = Object.keys(analytics.statusCounts);
  return (
    <Page
      title={`${heading} workspace`}
      intro="Review complaints visible to your authenticated department membership. Visibility does not grant mutation rights."
      actions={<ButtonLink to="/department/complaints">View department complaints</ButtonLink>}
    >
      <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
      <div className="flex flex-col gap-10">
        <section aria-labelledby="department-summary-heading">
          <div className="mb-4">
            <h2 id="department-summary-heading" className="text-[1.25rem]">Department workload</h2>
            <p className="mt-1 text-[0.875rem] text-ink-muted">Counts reflect the complete complaint list returned for this department context. Duplicate IDs are counted once.</p>
          </div>
          <div className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard label="Visible complaints" value={analytics.total} />
            {statusOptions.map((status) => (
              <MetricCard key={status} label={getStatusMeta(status).label} value={analytics.statusCounts[status] ?? 0} />
            ))}
          </div>
        </section>

        <section aria-labelledby="department-insights-heading">
          <div className="mb-4">
            <h2 id="department-insights-heading" className="text-[1.25rem]">Operational insights</h2>
            <p className="mt-1 text-[0.875rem] text-ink-muted">
              Client-derived from this complete authorized department response. These are not platform-wide totals or official SLA measures.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card>
              <h3 className="text-[1.125rem]">Reports by category</h3>
              {analytics.categoryCounts.length === 0 ? (
                <p className="mt-3 text-[0.875rem] text-ink-muted">No category values were returned.</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[18rem] text-left text-[0.875rem]">
                    <caption className="sr-only">Department complaint counts by category</caption>
                    <thead>
                      <tr className="border-b border-hairline text-ink-muted">
                        <th scope="col" className="px-2 py-2 font-normal">Category</th>
                        <th scope="col" className="px-2 py-2 text-right font-normal">Reports</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.categoryCounts.map((category) => (
                        <tr key={category.id} className="border-b border-hairline">
                          <th scope="row" className="px-2 py-3 font-normal">{category.label}</th>
                          <td className="px-2 py-3 text-right font-semibold">{category.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card>
              <h3 className="text-[1.125rem]">Resolution duration</h3>
              {analytics.resolutionDuration.averageHours === null ? (
                <p className="mt-3 text-[0.875rem] text-ink-muted">
                  Unavailable: no complaint had both a valid submission timestamp and a valid resolved or closed history event.
                </p>
              ) : (
                <>
                  <p className="mt-3 text-[2rem] font-semibold" aria-label={`Average resolution duration: ${formatHours(analytics.resolutionDuration.averageHours)}`}>
                    {formatHours(analytics.resolutionDuration.averageHours)}
                  </p>
                  <p className="mt-2 text-[0.875rem] text-ink-muted">
                    Average time from report submission to the first resolved or closed event, across {analytics.resolutionDuration.sampleSize} complete record{analytics.resolutionDuration.sampleSize === 1 ? '' : 's'}.
                  </p>
                </>
              )}
            </Card>
          </div>
          <p className="mt-4 text-[0.75rem] text-ink-muted">
            Active or pending records: {analytics.activeOrPendingCount}. Resolved or closed records: {analytics.resolvedOrClosedCount}.
            Status labels follow the current complaint contract; unknown future statuses remain visible as returned.
          </p>
        </section>

        {complaints.length === 0 ? (
          <Card>
            <EmptyState
              title="No visible complaints"
              description="The backend returned no complaints for this authenticated department context. This is not a signal that complaints were deleted or rejected."
              action={<ButtonLink to="/department/complaints" variant="tertiary">Open complaint list</ButtonLink>}
            />
          </Card>
        ) : (
          <section aria-labelledby="department-recent-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="department-recent-heading" className="text-[1.25rem]">Recent department complaints</h2>
                <p className="mt-1 text-[0.875rem] text-ink-muted">Read-only staff view of the latest returned updates.</p>
              </div>
              <Link to="/department/complaints" className="text-[0.875rem] font-semibold">View all department complaints</Link>
            </div>
            <ul className="border-t border-hairline">
              {recent.map((complaint) => <RecentStaffComplaint key={complaint.publicId} complaint={complaint} />)}
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

function RecentStaffComplaint({ complaint }: { complaint: StaffComplaint }) {
  return (
    <li className="border-b border-hairline">
      <Link
        to={`/department/complaints/${encodeURIComponent(complaint.publicId)}`}
        className="grid gap-3 px-4 py-4 text-ink no-underline transition-colors hover:bg-surface-1 md:grid-cols-[1fr_auto] md:items-center"
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

function formatHours(hours: number): string {
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}
