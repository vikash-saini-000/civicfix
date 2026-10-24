import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import type { WorkOrder, WorkOrderQuery, WorkOrderScope } from '../api/operationsTypes';
import { useAuth } from '../auth/AuthContext';
import { useDepartmentContext } from '../auth/useDepartmentContext';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DepartmentContextBar } from '../components/DepartmentContextBar';
import { EmptyState, ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { PriorityBadge } from '../components/Tag';
import { ReviewReasons, WorkOrderStatusTag } from '../components/Workflow';
import { formatDateTime } from '../lib/domain';
import { useRefreshOnActivity } from '../lib/refresh';
import { useResource } from '../lib/useResource';

export type WorkOrderView = 'work' | 'exceptions' | 'verification' | 'all';

const VIEWS: Record<WorkOrderView, { title: string; intro: string; status?: string[]; empty: string }> = {
  work: {
    title: 'Work orders',
    intro: 'Work assigned to you, or to your department. Open one to accept it, record progress or submit the fix.',
    empty: 'No work orders match this view.',
  },
  exceptions: {
    title: 'Assignment exceptions',
    intro: 'Work routed to your department that still needs a team member, or that is on hold.',
    status: ['PENDING_ASSIGNMENT', 'BLOCKED'],
    empty: 'Nothing is waiting for a team member or on hold.',
  },
  verification: {
    title: 'Resolution review',
    intro: 'Fixes submitted by your team. Check the evidence and approve, reject or ask for more.',
    status: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'],
    empty: 'No fixes are waiting for verification.',
  },
  all: {
    title: 'All work orders',
    intro: 'Every work order across departments.',
    empty: 'There are no work orders yet.',
  },
};

export function WorkOrdersPage({ view }: { view: WorkOrderView }) {
  const { state } = useAuth();
  const role = state.user?.role;
  const isAdmin = role === 'platform_admin';
  const config = VIEWS[view];
  const { context, memberships, selectDepartment } = useDepartmentContext();
  const [scope, setScope] = useState<WorkOrderScope>(isAdmin ? 'all' : view === 'work' && role === 'department_member' ? 'mine' : 'department');
  const [showClosed, setShowClosed] = useState(false);

  const query = useMemo<WorkOrderQuery | null>(() => {
    if (isAdmin) return { scope: 'all', status: config.status };
    if (!context) return null;
    return { scope, departmentId: scope === 'department' ? context.departmentId : undefined, status: config.status };
  }, [config.status, context, isAdmin, scope]);

  const list = useResource(query ? (signal) => api.listWorkOrders(query, signal) : null, [JSON.stringify(query)]);
  useRefreshOnActivity(list.reload, { enabled: Boolean(query) });

  const items = useMemo(() => {
    const all = list.data ?? [];
    if (showClosed || config.status) return all;
    return all.filter((wo) => wo.status !== 'COMPLETED' && wo.status !== 'CANCELLED');
  }, [config.status, list.data, showClosed]);

  return (
    <Page title={config.title} intro={config.intro} actions={<Button variant="tertiary" onClick={list.reload}>Refresh</Button>}>
      {!isAdmin && context && (
        <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
      )}
      {!isAdmin && view === 'work' && (
        <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Which work orders">
          <Button size="sm" variant={scope === 'mine' ? 'primary' : 'tertiary'} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>Assigned to me</Button>
          <Button size="sm" variant={scope === 'department' ? 'primary' : 'tertiary'} aria-pressed={scope === 'department'} onClick={() => setScope('department')}>Whole department</Button>
        </div>
      )}
      {!config.status && (
        <label className="mb-6 flex items-center gap-2 text-[0.875rem]">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show completed and cancelled work
        </label>
      )}
      {!query && <p className="text-ink-muted">Your account has no department membership.</p>}
      {list.loading && !list.data && <LoadingIndicator label="Loading work orders" />}
      {list.error && <ErrorState title="We could not load work orders" description={list.error} onRetry={list.reload} />}
      {list.data && items.length === 0 && (
        <Card>
          <EmptyState title="Nothing here" description={config.empty} />
        </Card>
      )}
      {items.length > 0 && <WorkOrderTable items={items} />}
    </Page>
  );
}

export function WorkOrderTable({ items }: { items: WorkOrder[] }) {
  return (
    <ul className="border-t border-hairline" aria-label="Work orders">
      {items.map((wo) => (
        <li key={wo.id} className="border-b border-hairline">
          <Link to={`/work-orders/${encodeURIComponent(wo.publicId)}`} className="grid gap-3 px-4 py-4 text-ink no-underline hover:bg-surface-1 md:grid-cols-[1fr_auto] md:items-center">
            <div className="min-w-0">
              <p className="font-mono text-[0.75rem] text-ink-muted">{wo.publicId} · {wo.complaint?.publicId}</p>
              <p className="truncate font-semibold">{wo.complaint?.title ?? 'Complaint unavailable'}</p>
              <p className="text-[0.875rem] text-ink-muted">
                {wo.department?.name ?? 'No department'} · {wo.assignee ? `Assigned to ${wo.assignee.name}` : 'Nobody assigned yet'}
                {wo.dueAt && ` · Due ${formatDateTime(wo.dueAt)}`}
              </p>
              {wo.reviewRequired.length > 0 && <div className="mt-2"><ReviewReasons reasons={wo.reviewRequired} /></div>}
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              {wo.overdue && <Badge tone="error">Overdue</Badge>}
              <PriorityBadge priority={wo.priority} />
              <WorkOrderStatusTag status={wo.status} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
