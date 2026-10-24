import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, USING_MOCK_API } from '../api';
import { ApiError } from '../api/errors';
import type { PlatformAnalyticsApi, PlatformComplaint } from '../api/types';
import { useOptionalAuth } from '../auth/AuthContext';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingIndicator } from '../components/Feedback';
import { Select, TextInput } from '../components/Field';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import {
  buildPlatformAnalytics,
  dateInputValue,
  dateRangeForPreset,
  type DateRange,
  type DateRangePreset,
  formatHours,
  uniqueComplaints,
  validateDateRange,
} from '../lib/analytics';
import { useRefreshOnActivity } from '../lib/refresh';

interface AdminDashboardPageProps {
  analyticsApi?: PlatformAnalyticsApi;
  now?: Date;
}

export function AdminDashboardPage({ analyticsApi = api, now }: AdminDashboardPageProps) {
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const [items, setItems] = useState<PlatformComplaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [preset, setPreset] = useState<DateRangePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [referenceDate] = useState(() => now ?? new Date());

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);
  useRefreshOnActivity(refresh);

  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setErrorMessage(null);
    analyticsApi
      .listPlatformComplaints(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(list)) {
          setErrorMessage('The analytics service returned an unexpected response. Please try again.');
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
        setErrorMessage(analyticsLoadErrorMessage(error));
      });
    return () => controller.abort();
  }, [analyticsApi, refreshSession, reloadToken]);

  const range = useMemo<DateRange>(() => {
    if (preset === 'custom') return { from: customFrom || null, to: customTo || null };
    return dateRangeForPreset(preset, referenceDate);
  }, [customFrom, customTo, preset, referenceDate]);
  const rangeError = preset === 'custom' ? validateDateRange(range) : null;
  const analytics = useMemo(
    () => (items && !rangeError ? buildPlatformAnalytics(items, range) : null),
    [items, range, rangeError],
  );
  const allRecords = items ? uniqueComplaints(items) : [];

  if (!items && !errorMessage) {
    return (
      <Page title="Platform overview" intro="Operational analytics for authorized platform administrators.">
        <LoadingIndicator label="Loading platform analytics" />
      </Page>
    );
  }

  if (errorMessage) {
    const unavailable = errorMessage === 'Platform analytics are not configured for the backend contract yet.';
    return (
      <Page title="Platform overview" intro="Operational analytics for authorized platform administrators.">
        <div className="max-w-2xl">
          <ErrorState
            title={unavailable ? 'Platform analytics are not configured' : 'We could not load platform analytics'}
            description={errorMessage}
            onRetry={() => setReloadToken((value) => value + 1)}
          />
          {unavailable && (
            <Card className="mt-6">
              <h2 className="text-[1.25rem]">Backend capability required</h2>
              <p className="mt-2 text-ink-muted">
                The HTTP client intentionally does not invent an analytics endpoint. Add an authorized, complete platform
                analytics contract before this view can display production-wide metrics.
              </p>
              <p className="mt-4 text-[0.875rem] text-ink-muted">
                Scoped department insights remain available from the existing <Link to="/department">department workspace</Link>.
              </p>
            </Card>
          )}
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Platform overview"
      intro="Review report volume, workload, categories, and resolution timing from the authorized platform dataset."
      actions={<Button variant="tertiary" onClick={() => setReloadToken((value) => value + 1)}>Refresh data</Button>}
    >
      {USING_MOCK_API && (
        <Notification kind="info" title="Development analytics dataset" className="mb-8">
          These values come from the complete local mock dataset. They are for interface validation only and are not production civic statistics.
        </Notification>
      )}

      <section aria-labelledby="filters-heading" className="mb-10">
        <Card>
          <div className="mb-5">
            <h2 id="filters-heading" className="text-[1.25rem]">Reporting period</h2>
            <p className="mt-1 text-[0.875rem] text-ink-muted">
              Date filtering is performed locally against the complete response returned by the current adapter.
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_1fr_1fr_auto] md:items-end">
            <Select label="Date range" value={preset} onChange={(event) => setPreset(event.target.value as DateRangePreset)}>
              <option value="all">All available dates</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="custom">Custom range</option>
            </Select>
            {preset === 'custom' ? (
              <>
                <TextInput
                  label="Start date"
                  type="date"
                  required
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  error={rangeError && !customFrom ? 'Choose a start date.' : undefined}
                />
                <TextInput
                  label="End date"
                  type="date"
                  required
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  error={rangeError && !customTo ? 'Choose an end date.' : undefined}
                />
              </>
            ) : (
              <div className="md:col-span-2">
                <p className="text-[0.75rem] tracking-[0.02em] text-ink-muted">Selected period</p>
                <p className="mt-2 min-h-12 border-b border-field-rule bg-surface-1 px-4 py-3 text-[0.875rem]">
                  {periodLabel(range, referenceDate)}
                </p>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setPreset('all'); setCustomFrom(''); setCustomTo(''); }} disabled={preset === 'all' && !customFrom && !customTo}>
              Reset
            </Button>
          </div>
          {rangeError && <p className="mt-4 text-[0.75rem] text-error" role="alert">{rangeError}</p>}
          <p className="mt-5 text-[0.875rem] text-ink-muted" aria-live="polite">
            {analytics
              ? `Showing ${analytics.total} of ${allRecords.length} unique reports returned by the platform adapter for ${periodLabel(range, referenceDate).toLocaleLowerCase()}.`
              : 'Choose a valid reporting period to view metrics.'}
          </p>
        </Card>
      </section>

      {rangeError ? (
        <Notification kind="warning" title="Choose a valid reporting period." className="mb-10">
          {rangeError}
        </Notification>
      ) : analytics ? (
      <div aria-busy={!items} className="flex flex-col gap-10">
        {analytics.invalidCreatedAtCount > 0 && (
          <Notification kind="warning" title="Some reports are unavailable to date-based metrics">
            {analytics.invalidCreatedAtCount} report{analytics.invalidCreatedAtCount === 1 ? '' : 's'} returned without a valid submission timestamp cannot be placed in the selected period or trend.
          </Notification>
        )}
        <section aria-labelledby="summary-heading">
          <div className="mb-4">
            <h2 id="summary-heading" className="text-[1.25rem]">Summary metrics</h2>
            <p className="mt-1 text-[0.875rem] text-ink-muted">Counts use unique records created inside the selected period.</p>
          </div>
          <div className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard label="Total reports" value={analytics.total} />
            <MetricCard label="Unresolved reports" value={analytics.activeOrPendingCount} />
            <MetricCard label="In progress" value={analytics.statusCounts.IN_PROGRESS ?? 0} />
            <MetricCard label="Resolved or closed" value={analytics.resolvedOrClosedCount} />
            <MetricCard label="Awaiting verification" value={analytics.statusCounts.VERIFICATION_REQUIRED ?? 0} />
            <MetricCard label="Rejected" value={analytics.statusCounts.REJECTED ?? 0} />
          </div>
        </section>

        {!analytics.total ? (
          <Card>
            <EmptyState title="No reports in this period" description="The complete authorized response contains no reports with a submission date in the selected period. Zero is shown in the summary cards; unavailable metrics remain labelled separately." />
          </Card>
        ) : (
          <>
            <section aria-labelledby="trend-heading">
              <div className="mb-4">
                <h2 id="trend-heading" className="text-[1.25rem]">Report volume over time</h2>
                <p className="mt-1 text-[0.875rem] text-ink-muted">Reports created per {analytics.trendBucket}. The table is the accessible exact-value representation.</p>
              </div>
              <Card>
                <TrendTable points={analytics.trend} />
              </Card>
            </section>

            <section aria-labelledby="distribution-heading">
              <div className="mb-4">
                <h2 id="distribution-heading" className="text-[1.25rem]">Operational distribution</h2>
                <p className="mt-1 text-[0.875rem] text-ink-muted">Category and department workload from the same selected period.</p>
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <h3 className="text-[1.125rem]">Reports by category</h3>
                  <CategoryTable categories={analytics.categoryCounts} />
                </Card>
                <Card>
                  <h3 className="text-[1.125rem]">Department workload</h3>
                  <DepartmentTable departments={analytics.departmentWorkload} />
                </Card>
              </div>
            </section>
          </>
        )}

        <section aria-labelledby="performance-heading">
          <div className="mb-4">
            <h2 id="performance-heading" className="text-[1.25rem]">Resolution performance</h2>
            <p className="mt-1 text-[0.875rem] text-ink-muted">Client-derived timing from valid submission and resolved/closed history timestamps.</p>
          </div>
          <Card>
            {analytics.resolutionDuration.averageHours === null ? (
              <p className="text-[0.875rem] text-ink-muted">Unavailable for this period: no report has both required timestamps.</p>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2">
                <MetricCard label="Average resolution duration" value={formatHours(analytics.resolutionDuration.averageHours)} detail={`Based on ${analytics.resolutionDuration.sampleSize} complete report${analytics.resolutionDuration.sampleSize === 1 ? '' : 's'}.`} />
                <MetricCard label="Median resolution duration" value={formatHours(analytics.resolutionDuration.medianHours ?? 0)} detail="Median uses the same complete records as the average." />
              </div>
            )}
          </Card>
        </section>
      </div>
      ) : null}
    </Page>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return (
    <Card className="border-0 bg-canvas">
      <p className="text-[0.75rem] text-ink-muted">{label}</p>
      <p className="mt-2 text-[2rem] leading-none font-semibold" aria-label={`${label}: ${value}`}>{value}</p>
      {detail && <p className="mt-3 text-[0.75rem] text-ink-muted">{detail}</p>}
    </Card>
  );
}

function TrendTable({ points }: { points: { key: string; label: string; count: number }[] }) {
  const maximum = Math.max(...points.map((point) => point.count), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-[0.875rem]">
        <caption className="sr-only">Report volume trend</caption>
        <thead>
          <tr className="border-b border-hairline text-ink-muted">
            <th scope="col" className="px-2 py-2 font-normal">Period</th>
            <th scope="col" className="px-2 py-2 font-normal">Reports created</th>
            <th scope="col" className="w-1/2 px-2 py-2 font-normal"><span className="sr-only">Relative volume</span></th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key} className="border-b border-hairline">
              <th scope="row" className="whitespace-nowrap px-2 py-3 font-normal">{point.label}</th>
              <td className="px-2 py-3 font-semibold">{point.count}</td>
              <td className="px-2 py-3"><span aria-hidden="true" className="block h-3 bg-primary" style={{ width: `${(point.count / maximum) * 100}%`, minWidth: point.count ? '0.25rem' : undefined }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryTable({ categories }: { categories: { id: string; label: string; count: number }[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[18rem] text-left text-[0.875rem]">
        <caption className="sr-only">Platform report counts by category</caption>
        <thead><tr className="border-b border-hairline text-ink-muted"><th scope="col" className="px-2 py-2 font-normal">Category</th><th scope="col" className="px-2 py-2 text-right font-normal">Reports</th></tr></thead>
        <tbody>
          {categories.map((category) => <tr key={category.id} className="border-b border-hairline"><th scope="row" className="px-2 py-3 font-normal">{category.label}</th><td className="px-2 py-3 text-right font-semibold">{category.count}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function DepartmentTable({ departments }: { departments: { name: string; total: number; unresolved: number; resolvedOrClosed: number }[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-[0.875rem]">
        <caption className="sr-only">Platform report workload by department</caption>
        <thead><tr className="border-b border-hairline text-ink-muted"><th scope="col" className="px-2 py-2 font-normal">Department</th><th scope="col" className="px-2 py-2 text-right font-normal">Total</th><th scope="col" className="px-2 py-2 text-right font-normal">Unresolved</th><th scope="col" className="px-2 py-2 text-right font-normal">Resolved/closed</th></tr></thead>
        <tbody>
          {departments.map((department) => <tr key={department.name} className="border-b border-hairline"><th scope="row" className="px-2 py-3 font-normal">{department.name}</th><td className="px-2 py-3 text-right font-semibold">{department.total}</td><td className="px-2 py-3 text-right">{department.unresolved}</td><td className="px-2 py-3 text-right">{department.resolvedOrClosed}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function periodLabel(range: DateRange, referenceDate: Date): string {
  if (!range.from && !range.to) return 'All available dates';
  const from = range.from ? formatDate(range.from) : 'first available date';
  const to = range.to ? formatDate(range.to) : dateInputValue(referenceDate);
  return `${from} to ${to}`;
}

function formatDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return 'Date unavailable';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

function analyticsLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'PLATFORM_ANALYTICS_NOT_CONFIGURED') return 'Platform analytics are not configured for the backend contract yet.';
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return 'Your account is not authorized to view platform analytics.';
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) return 'The analytics service could not be reached. Check your connection and try again.';
  return 'We could not load platform analytics. Please try again.';
}
