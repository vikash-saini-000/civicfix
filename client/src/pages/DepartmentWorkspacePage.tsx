import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import type { DepartmentApi, StaffComplaint } from '../api/types';
import { useAuth } from '../auth/AuthContext';
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

interface DepartmentWorkspacePageProps {
  departmentApi?: DepartmentApi;
}

export function DepartmentWorkspacePage({ departmentApi = api }: DepartmentWorkspacePageProps) {
  const { state } = useAuth();
  const { context, memberships, selectDepartment, hasInvalidRequestedContext } = useDepartmentContext();
  const [items, setItems] = useState<StaffComplaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

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
        if (!controller.signal.aborted) setErrorMessage(staffLoadErrorMessage(error));
      });
    return () => controller.abort();
  }, [context, departmentApi, hasInvalidRequestedContext, reloadToken]);

  const recent = useMemo(() => (items ? sortComplaints(items, 'updated-desc').slice(0, 5) : []), [items]);
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

  const complaints = items ?? [];
  const statusOptions = [...new Set(complaints.map((complaint) => complaint.status))];
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
            <p className="mt-1 text-[0.875rem] text-ink-muted">Counts reflect the complete complaint list returned for this department context.</p>
          </div>
          <div className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard label="Visible complaints" value={complaints.length} />
            {statusOptions.map((status) => (
              <MetricCard key={status} label={getStatusMeta(status).label} value={complaints.filter((complaint) => complaint.status === status).length} />
            ))}
          </div>
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
