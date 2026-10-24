import { useState } from 'react';
import { api } from '../api';
import type { AdminDashboard } from '../api/operationsTypes';
import { useDepartmentContext } from '../auth/useDepartmentContext';
import { Badge } from '../components/Badge';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { DepartmentContextBar } from '../components/DepartmentContextBar';
import { ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { MetricGrid, MetricTile } from '../components/Workflow';
import { categoryLabel } from '../lib/domain';
import { useRefreshOnActivity } from '../lib/refresh';
import { useResource } from '../lib/useResource';
import { workOrderStatusMeta } from '../lib/workflow';

function hours(value: number | null): string {
  if (value === null) return '—';
  return value < 48 ? `${value.toFixed(1)} h` : `${(value / 24).toFixed(1)} days`;
}

/** GET /dashboard/department/manager: live counts for one department (last 30 days where noted). */
export function ManagerOverviewPage() {
  const { context, memberships, selectDepartment } = useDepartmentContext();
  const managed = memberships.filter((m) => m.role === 'manager');
  const departmentId = context?.membershipRole === 'manager' ? context.departmentId : managed[0]?.departmentId;
  const dashboard = useResource(departmentId ? (signal) => api.getManagerDashboard(departmentId, signal) : null, [departmentId]);
  useRefreshOnActivity(dashboard.reload, { enabled: Boolean(departmentId) });
  const d = dashboard.data;

  return (
    <Page
      title={d ? `${d.department.name} overview` : 'Department overview'}
      intro="Live workload for your department. Ranges cover the last 30 days."
      actions={<Button variant="tertiary" onClick={dashboard.reload}>Refresh</Button>}
    >
      {managed.length > 1 && departmentId && (
        <DepartmentContextBar memberships={managed} selectedDepartmentId={departmentId} onChange={selectDepartment} />
      )}
      {!departmentId && <p className="text-ink-muted">You do not manage a department.</p>}
      {dashboard.loading && !d && <LoadingIndicator label="Loading department metrics" />}
      {dashboard.error && <ErrorState title="We could not load the overview" description={dashboard.error} onRetry={dashboard.reload} />}
      {d && (
        <div className="flex flex-col gap-10">
          <MetricGrid>
            <MetricTile label="Waiting for routing" value={d.complaints.awaitingRouting} />
            <MetricTile label="Open work orders" value={d.workOrders.open} />
            <MetricTile label="Need a team member" value={d.workOrders.unassigned} />
            <MetricTile label="Overdue" value={d.workOrders.overdue} />
            <MetricTile label="Fixes to verify" value={d.workOrders.pendingVerification} />
            <MetricTile label="On hold" value={d.workOrders.blocked} />
            <MetricTile label="Open disputes" value={d.openDisputes} />
            <MetricTile label="Average time to resolve" value={hours(d.resolution.averageHoursToResolve)} hint={`${d.resolution.resolvedInRange} resolved in range`} />
          </MetricGrid>
          <div className="flex flex-wrap gap-3">
            <ButtonLink to="/manager/review">Review queue</ButtonLink>
            <ButtonLink to="/manager/exceptions" variant="tertiary">Assignment exceptions</ButtonLink>
            <ButtonLink to="/manager/resolution-review" variant="tertiary">Resolution review</ButtonLink>
          </div>
          <section aria-labelledby="workload-heading">
            <h2 id="workload-heading" className="mb-4 text-[1.25rem]">Team workload</h2>
            {d.workload.length === 0 ? (
              <p className="text-ink-muted">No active members.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] text-left text-[0.875rem]">
                  <thead>
                    <tr className="border-b border-hairline text-ink-muted">
                      <th scope="col" className="px-2 py-2 font-normal">Member</th>
                      <th scope="col" className="px-2 py-2 font-normal">Role</th>
                      <th scope="col" className="px-2 py-2 text-right font-normal">Open work</th>
                      <th scope="col" className="px-2 py-2 text-right font-normal">Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.workload.map((w) => (
                      <tr key={w.member.id} className="border-b border-hairline">
                        <th scope="row" className="px-2 py-3 font-normal">{w.member.name}</th>
                        <td className="px-2 py-3">{w.role === 'MANAGER' ? 'Manager' : 'Member'}</td>
                        <td className="px-2 py-3 text-right font-semibold">{w.openWorkOrders}</td>
                        <td className="px-2 py-3 text-right">{w.overdue > 0 ? <Badge tone="error">{w.overdue}</Badge> : 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <CountTable title="Work orders by status" counts={d.workOrders.byStatus} label={(s) => workOrderStatusMeta(s).label} />
          <CountTable title="Complaints by category" counts={d.complaints.byCategory} label={categoryLabel} />
        </div>
      )}
    </Page>
  );
}

/** Live platform metrics from GET /dashboard/admin, shown above the complaint analytics. */
export function AdminLiveMetrics() {
  const dashboard = useResource((signal) => api.getAdminDashboard(signal), []);
  const d: AdminDashboard | null = dashboard.data;
  if (dashboard.loading && !d) return <LoadingIndicator label="Loading live operations" />;
  if (dashboard.error) return <ErrorState title="Live operations could not be loaded" description={dashboard.error} onRetry={dashboard.reload} />;
  if (!d) return null;
  const aiDone = d.ai.classificationsInRange.SUCCEEDED ?? 0;
  const aiFailed = (d.ai.classificationsInRange.FAILED ?? 0) + (d.ai.classificationsInRange.INVALID_OUTPUT ?? 0);
  return (
    <section aria-labelledby="live-heading" className="mb-10 flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="live-heading" className="text-[1.25rem]">Live operations</h2>
          <p className="mt-1 text-[0.875rem] text-ink-muted">From the server, last 30 days where noted.</p>
        </div>
        <div className="flex gap-3">
          <ButtonLink to="/admin/triage" size="sm">Triage queue ({d.complaints.awaitingRouting})</ButtonLink>
          <ButtonLink to="/admin/work-orders" size="sm" variant="tertiary">Work orders</ButtonLink>
        </div>
      </div>
      <MetricGrid>
        <MetricTile label="Waiting for routing" value={d.complaints.awaitingRouting} />
        <MetricTile label="Open work orders" value={d.workOrders.open} />
        <MetricTile label="Overdue" value={d.workOrders.overdue} />
        <MetricTile label="Fixes to verify" value={d.workOrders.pendingVerification} />
        <MetricTile label="New complaints (30 days)" value={d.complaints.createdInRange} />
        <MetricTile label="Resolved (30 days)" value={d.resolution.resolvedInRange} hint={`Average ${hours(d.resolution.averageHoursToResolve)}`} />
        <MetricTile label="Open disputes" value={d.disputes.open} />
        <MetricTile label="AI classifications" value={aiDone} hint={`${aiFailed} failed · ${d.ai.autoAssignedInRange} auto-assigned`} />
      </MetricGrid>
      <Card>
        <h3 className="mb-3 text-[1.125rem]">Departments</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-[0.875rem]">
            <thead>
              <tr className="border-b border-hairline text-ink-muted">
                <th scope="col" className="px-2 py-2 font-normal">Department</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Open work</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {d.departments.map((dept) => (
                <tr key={dept.id} className="border-b border-hairline">
                  <th scope="row" className="px-2 py-3 font-normal">{dept.name}{!dept.isActive && <span className="text-ink-muted"> (inactive)</span>}</th>
                  <td className="px-2 py-3 text-right font-semibold">{dept.openWorkOrders}</td>
                  <td className="px-2 py-3 text-right">{dept.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

/** Departments and their members (GET /departments, GET /departments/:id/members). */
export function AdminDepartmentsPage() {
  const departments = useResource((signal) => api.listDepartments(signal), []);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Page title="Departments" intro="Municipal teams, the categories they handle, and their members.">
      {departments.loading && !departments.data && <LoadingIndicator label="Loading departments" />}
      {departments.error && <ErrorState title="We could not load departments" description={departments.error} onRetry={departments.reload} />}
      <ul className="flex flex-col gap-4">
        {(departments.data ?? []).map((d) => (
          <li key={d.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[1.125rem]">{d.name}</h2>
                  <p className="mt-1 text-[0.875rem] text-ink-muted">{d.categories.map(categoryLabel).join(' · ') || 'No categories'}</p>
                </div>
                <Button size="sm" variant="tertiary" onClick={() => setOpenId(openId === d.id ? null : d.id)} aria-expanded={openId === d.id}>
                  {openId === d.id ? 'Hide members' : 'Show members'}
                </Button>
              </div>
              {openId === d.id && <Members departmentId={d.id} />}
            </Card>
          </li>
        ))}
      </ul>
    </Page>
  );
}

function Members({ departmentId }: { departmentId: string }) {
  const members = useResource((signal) => api.listDepartmentMembers(departmentId, signal), [departmentId]);
  if (members.loading && !members.data) return <div className="mt-4"><LoadingIndicator label="Loading members" /></div>;
  if (members.error) return <div className="mt-4"><ErrorState title="Members could not be loaded" description={members.error} onRetry={members.reload} /></div>;
  if (!members.data?.length) return <p className="mt-4 text-[0.875rem] text-ink-muted">No active members.</p>;
  return (
    <ul className="mt-4 border-t border-hairline text-[0.875rem]">
      {members.data.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline py-2">
          <span>{m.user.name} <span className="text-ink-muted">· {m.user.email}</span></span>
          <Badge tone={m.role === 'MANAGER' ? 'info' : 'neutral'}>{m.role === 'MANAGER' ? 'Manager' : 'Member'}</Badge>
        </li>
      ))}
    </ul>
  );
}

function CountTable({ title, counts, label }: { title: string; counts: Record<string, number>; label: (key: string) => string }) {
  const rows = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <section>
      <h2 className="mb-4 text-[1.25rem]">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-ink-muted">Nothing to show.</p>
      ) : (
        <ul className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([key, n]) => (
            <li key={key} className="flex items-center justify-between bg-canvas px-4 py-3 text-[0.875rem]">
              <span>{label(key)}</span>
              <span className="font-semibold">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
