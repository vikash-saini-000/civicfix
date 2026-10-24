import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { ButtonLink } from '../components/Button';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { PriorityBadge, StatusTag } from '../components/Tag';
import { categoryLabel, formatDateTime, type Complaint } from '../lib/domain';

export function ComplaintsPage() {
  const [items, setItems] = useState<Complaint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listMyComplaints()
      .then((list) => alive && setItems(list))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Page
      title="My complaints"
      intro="Everything you have reported, newest activity first."
      actions={<ButtonLink to="/report">Report a problem</ButtonLink>}
    >
      {error && <Notification kind="error" title="We could not load your complaints. Refresh the page to try again." />}
      {!items && !error && <ListSkeleton />}
      {items && items.length === 0 && (
        <div className="border border-hairline p-8">
          <h2 className="text-[1.25rem]">No complaints yet</h2>
          <p className="mt-2 text-ink-muted">When you report a problem, you can follow its progress here.</p>
        </div>
      )}
      {items && items.length > 0 && (
        <ul className="border-t border-hairline">
          {items.map((c) => (
            <li key={c.publicId} className="border-b border-hairline">
              <Link
                to={`/complaints/${c.publicId}`}
                className="grid gap-2 md:grid-cols-[1fr_auto] md:items-center px-4 py-4 no-underline text-ink hover:bg-surface-1"
              >
                <div className="min-w-0">
                  <p className="text-[0.75rem] text-ink-muted font-mono">{c.publicId}</p>
                  <p className="font-semibold truncate">{c.title}</p>
                  <p className="text-[0.875rem] text-ink-muted">
                    {categoryLabel(c.confirmedCategory ?? c.selectedCategory)} · Updated {formatDateTime(c.updatedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusTag status={c.status} />
                  <PriorityBadge priority={c.priority} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function ListSkeleton() {
  return (
    <ul className="border-t border-hairline" aria-busy="true" aria-label="Loading complaints">
      {[0, 1, 2].map((i) => (
        <li key={i} className="border-b border-hairline px-4 py-4">
          <div className="h-3 w-24 bg-surface-2 mb-2 animate-pulse" />
          <div className="h-4 w-2/3 bg-surface-2 mb-2 animate-pulse" />
          <div className="h-3 w-1/3 bg-surface-1 animate-pulse" />
        </li>
      ))}
    </ul>
  );
}
