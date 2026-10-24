import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { DepartmentApi, StaffComplaint } from '../api/types';
import { useOptionalAuth } from '../auth/AuthContext';
import { useDepartmentContext } from '../auth/useDepartmentContext';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { DepartmentContextBar } from '../components/DepartmentContextBar';
import { EmptyState, ErrorState } from '../components/Feedback';
import { Select } from '../components/Field';
import { SearchInput } from '../components/SearchInput';
import { Page } from '../components/Layout';
import { PriorityBadge, StatusTag } from '../components/Tag';
import { complaintCategoryOptions, complaintStatusOptions, sortComplaints, staffComplaintSearchText, staffLoadErrorMessage, priorityOptions, type ComplaintSort } from '../lib/department';
import { complaintLocationLabel } from '../lib/complaints';
import { categoryLabel, formatDateTime, getPriorityMeta, getStatusMeta } from '../lib/domain';
import { uniqueComplaints } from '../lib/analytics';
import { useRefreshOnActivity } from '../lib/refresh';

interface DepartmentComplaintsPageProps {
  departmentApi?: DepartmentApi;
}

export function DepartmentComplaintsPage({ departmentApi = api }: DepartmentComplaintsPageProps) {
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const { context, memberships, selectDepartment, hasInvalidRequestedContext } = useDepartmentContext();
  const [items, setItems] = useState<StaffComplaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState<ComplaintSort>('updated-desc');

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
        if (Array.isArray(list)) setItems(uniqueComplaints(list));
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

  const filteredItems = useMemo(() => {
    if (!items) return [];
    const query = search.trim().toLocaleLowerCase();
    return sortComplaints(
      items.filter((complaint) => {
        const matchesSearch = !query || staffComplaintSearchText(complaint).includes(query);
        const matchesStatus = !status || complaint.status === status;
        const selectedCategory = complaint.confirmedCategory ?? complaint.selectedCategory;
        const matchesCategory = !category || selectedCategory === category;
        const matchesPriority = !priority || complaint.priority === priority;
        return matchesSearch && matchesStatus && matchesCategory && matchesPriority;
      }),
      sort,
    );
  }, [category, items, priority, search, sort, status]);

  const statusOptions = useMemo(() => complaintStatusOptions(items ?? []), [items]);
  const categoryOptions = useMemo(() => complaintCategoryOptions(items ?? []), [items]);
  const priorityFilterOptions = useMemo(() => priorityOptions(items ?? []), [items]);
  const hasFilters = Boolean(search.trim() || status || category || priority || sort !== 'updated-desc');
  const heading = context?.departmentName ?? context?.departmentId ?? 'Department complaints';

  function resetFilters() {
    setSearch('');
    setStatus('');
    setCategory('');
    setPriority('');
    setSort('updated-desc');
  }

  if (!context) {
    return (
      <Page title="Department complaints" intro="Department context could not be established safely.">
        <Card className="max-w-xl">
          <h2 className="text-[1.25rem]">Department context unavailable</h2>
          <p className="mt-2 text-ink-muted">
            {hasInvalidRequestedContext ? 'The requested department is not one of your authenticated memberships.' : 'Your account has no usable department context.'}
          </p>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title={`${heading} complaints`}
      intro="Read-only complaints returned for your authenticated department membership. Visibility does not authorize changes."
      actions={<ButtonLink to="/department">Department workspace</ButtonLink>}
    >
      <DepartmentContextBar memberships={memberships} selectedDepartmentId={context.departmentId} onChange={selectDepartment} />
      {errorMessage && (
        <div className="mb-8 max-w-xl">
          <ErrorState title="We could not load department complaints" description={errorMessage} onRetry={() => setReloadToken((value) => value + 1)} />
        </div>
      )}
      {!items && !errorMessage && <ListSkeleton />}
      {items && (
        <div className="flex flex-col gap-6">
          <Card>
            <div className="grid gap-5 md:grid-cols-[minmax(0,2fr)_1fr_1fr]">
              <SearchInput label="Search department complaints" placeholder="Search by title, ID, or location" value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch('')} />
              <Select label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All statuses</option>
                {statusOptions.map((value) => <option key={value} value={value}>{getStatusMeta(value).label}</option>)}
              </Select>
              <Select label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All categories</option>
                {categoryOptions.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}
              </Select>
            </div>
            <div className="mt-5 grid gap-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Select label="Priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
                <option value="">All priorities</option>
                {priorityFilterOptions.map((value) => <option key={value} value={value}>{getPriorityMeta(value).label}</option>)}
              </Select>
              <Select label="Sort by" value={sort} onChange={(event) => setSort(event.target.value as ComplaintSort)}>
                <option value="updated-desc">Recently updated</option>
                <option value="created-desc">Recently reported</option>
                <option value="title-asc">Title A–Z</option>
              </Select>
              <Button variant="ghost" size="sm" onClick={resetFilters} disabled={!hasFilters}>Reset filters</Button>
            </div>
            <p className="mt-5 text-[0.875rem] text-ink-muted" aria-live="polite">
              Showing {filteredItems.length} of {items.length} complaints returned for this department.
            </p>
          </Card>

          {items.length === 0 ? (
            <Card>
              <EmptyState title="No visible department complaints" description="The authorized department response was empty." action={<ButtonLink to="/department" variant="tertiary">Back to workspace</ButtonLink>} />
            </Card>
          ) : filteredItems.length === 0 ? (
            <Card>
              <EmptyState title="No complaints match these filters" description="Try a different search or clear the filters." action={<Button variant="tertiary" onClick={resetFilters}>Clear filters</Button>} />
            </Card>
          ) : (
            <ul className="border-t border-hairline">
              {filteredItems.map((complaint) => <DepartmentComplaintRow key={complaint.publicId} complaint={complaint} />)}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}

function DepartmentComplaintRow({ complaint }: { complaint: StaffComplaint }) {
  return (
    <li className="border-b border-hairline">
      <Link to={`/department/complaints/${encodeURIComponent(complaint.publicId)}`} className="grid gap-4 px-4 py-5 text-ink no-underline transition-colors hover:bg-surface-1 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0">
          <p className="font-mono text-[0.75rem] text-ink-muted">{complaint.publicId}</p>
          <h2 className="mt-1 truncate text-[1.125rem] font-semibold">{complaint.title}</h2>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.875rem] text-ink-muted">
            <span>{categoryLabel(complaint.confirmedCategory ?? complaint.selectedCategory)}</span>
            <span>{complaintLocationLabel(complaint)}</span>
            <span>Reported {formatDateTime(complaint.createdAt)}</span>
            <span>Updated {formatDateTime(complaint.updatedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <StatusTag status={complaint.status} />
          <PriorityBadge priority={complaint.priority} />
        </div>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul className="border-t border-hairline" aria-busy="true" aria-label="Loading department complaints">
      {[0, 1, 2].map((index) => (
        <li key={index} className="border-b border-hairline px-4 py-5">
          <div className="mb-2 h-3 w-24 animate-pulse bg-surface-2" />
          <div className="mb-2 h-5 w-2/3 animate-pulse bg-surface-2" />
          <div className="h-3 w-1/2 animate-pulse bg-surface-1" />
        </li>
      ))}
    </ul>
  );
}
