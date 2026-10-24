import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import { useOptionalAuth } from '../auth/AuthContext';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState, ErrorState } from '../components/Feedback';
import { Select } from '../components/Field';
import { SearchInput } from '../components/SearchInput';
import { Page } from '../components/Layout';
import { StatusTag } from '../components/Tag';
import {
  complaintLoadErrorMessage,
  complaintCategoryOptions,
  complaintLocationLabel,
  complaintSearchText,
  complaintStatusOptions,
  sortComplaints,
  type ComplaintSort,
} from '../lib/complaints';
import {
  categoryLabel,
  formatDateTime,
  getStatusMeta,
  type Complaint,
} from '../lib/domain';
import { uniqueComplaints } from '../lib/analytics';
import { useRefreshOnActivity } from '../lib/refresh';

interface ComplaintsPageProps {
  complaintApi?: ComplaintApi;
}

export function ComplaintsPage({ complaintApi = api }: ComplaintsPageProps) {
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const [items, setItems] = useState<Complaint[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<ComplaintSort>('updated-desc');

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

  const filteredItems = useMemo(() => {
    if (!items) return [];
    const query = search.trim().toLocaleLowerCase();
    const filtered = items.filter((complaint) => {
      const matchesSearch = !query || complaintSearchText(complaint).includes(query);
      const matchesStatus = !status || complaint.status === status;
      const selectedCategory = complaint.confirmedCategory ?? complaint.selectedCategory;
      const matchesCategory = !category || selectedCategory === category;
      return matchesSearch && matchesStatus && matchesCategory;
    });
    return sortComplaints(filtered, sort);
  }, [category, items, search, sort, status]);

  const statusOptions = useMemo(() => complaintStatusOptions(items ?? []), [items]);
  const categoryOptions = useMemo(() => complaintCategoryOptions(items ?? []), [items]);

  const hasFilters = Boolean(search.trim() || status || category || sort !== 'updated-desc');

  function retry() {
    setReloadToken((value) => value + 1);
  }

  function resetFilters() {
    setSearch('');
    setStatus('');
    setCategory('');
    setSort('updated-desc');
  }

  return (
    <Page
      title="My complaints"
      intro="Everything you have reported, with the latest status and public updates."
      actions={<ButtonLink to="/citizen/complaints/new">Report an issue</ButtonLink>}
    >
      {errorMessage && (
        <div className="mb-8">
          <ErrorState title="We could not load your complaints" description={errorMessage} onRetry={retry} />
        </div>
      )}

      {!items && !errorMessage && <ListSkeleton />}

      {items && (
        <div className="flex flex-col gap-6">
          <Card>
            <div className="grid gap-5 md:grid-cols-[minmax(0,2fr)_1fr_1fr]">
              <SearchInput
                label="Search complaints"
                placeholder="Search by title or complaint ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onClear={() => setSearch('')}
              />
              <Select label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All statuses</option>
                {statusOptions.map((value) => <option key={value} value={value}>{getStatusMeta(value).label}</option>)}
              </Select>
              <Select label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All categories</option>
                {categoryOptions.map((value) => <option key={value} value={value}>{categoryLabel(value)}</option>)}
              </Select>
            </div>
            <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
              <Select label="Sort by" value={sort} onChange={(event) => setSort(event.target.value as ComplaintSort)} className="max-w-xs">
                <option value="updated-desc">Recently updated</option>
                <option value="created-desc">Recently reported</option>
                <option value="title-asc">Title A–Z</option>
              </Select>
              <Button variant="ghost" size="sm" onClick={resetFilters} disabled={!hasFilters}>Reset filters</Button>
            </div>
            <p className="mt-5 text-[0.875rem] text-ink-muted" aria-live="polite">
              Showing {filteredItems.length} of {items.length} complaints returned for your account.
            </p>
          </Card>

          {items.length === 0 ? (
            <Card>
              <EmptyState
                title="No complaints yet"
                description="You have not submitted a civic issue yet. Report one to start following its progress."
                action={<ButtonLink to="/citizen/complaints/new">Report an issue</ButtonLink>}
              />
            </Card>
          ) : filteredItems.length === 0 ? (
            <Card>
              <EmptyState
                title="No complaints match these filters"
                description="Try a different search or clear the filters to see all of your complaints."
                action={<Button variant="tertiary" onClick={resetFilters}>Clear filters</Button>}
              />
            </Card>
          ) : (
            <ul className="border-t border-hairline">
              {filteredItems.map((complaint) => <ComplaintRow key={complaint.publicId} complaint={complaint} />)}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}

function ComplaintRow({ complaint }: { complaint: Complaint }) {
  return (
    <li className="border-b border-hairline">
      <Link
        to={`/citizen/complaints/${encodeURIComponent(complaint.publicId)}`}
        className="grid gap-4 px-4 py-5 no-underline text-ink transition-colors hover:bg-surface-1 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      >
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
        <StatusTag status={complaint.status} />
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul className="border-t border-hairline" aria-busy="true" aria-label="Loading complaints">
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
