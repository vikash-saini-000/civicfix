import { Link } from 'react-router';
import { api } from '../api';
import type { AppNotification } from '../api/operationsTypes';
import type { Role } from '../api/authTypes';
import { formatDateTime } from '../lib/domain';
import { useAction, useResource } from '../lib/useResource';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { EmptyState, ErrorState, LoadingIndicator } from './Feedback';
import { Notification } from './Notification';

/** In-app notifications from GET /notifications (docs/api/NOTIFICATIONS_AUDIT.md). */
export function BackendNotifications({ role }: { role: Role }) {
  const list = useResource((signal) => api.listNotifications(signal), []);
  const action = useAction();
  const unread = (list.data ?? []).filter((n) => !n.readAt).length;

  async function markAll() {
    await action.run(() => api.markAllNotificationsRead());
    list.reload();
    window.dispatchEvent(new Event('civicfix:notifications-changed'));
  }

  async function open(notification: AppNotification) {
    if (notification.readAt) return;
    await action.run(() => api.markNotificationRead(notification.id));
    window.dispatchEvent(new Event('civicfix:notifications-changed'));
  }

  if (list.loading && !list.data) return <LoadingIndicator label="Loading notifications" />;
  if (list.error) return <ErrorState title="We could not load notifications" description={list.error} onRetry={list.reload} />;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.875rem] text-ink-muted" role="status" aria-live="polite">
          {unread === 0 ? 'You are all caught up.' : `${unread} unread notification${unread === 1 ? '' : 's'}.`}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={list.reload}>Refresh</Button>
          {unread > 0 && (
            <Button variant="tertiary" size="sm" onClick={() => void markAll()} disabled={action.busy}>Mark all as read</Button>
          )}
        </div>
      </div>
      {action.error && <Notification kind="error" title={action.error} className="mb-4" />}
      {!list.data?.length ? (
        <EmptyState title="No notifications yet" description="Updates about complaints and work will appear here." />
      ) : (
        <ol className="border-t border-hairline" aria-label="Notifications">
          {list.data.map((n) => (
            <li key={n.id} className={`grid gap-2 border-b border-hairline py-4 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4 ${n.readAt ? '' : 'bg-surface-1 px-2'}`}>
              <time dateTime={n.createdAt} className="text-[0.75rem] text-ink-muted">{formatDateTime(n.createdAt)}</time>
              <div className="min-w-0">
                {/* title and message are plain text by contract; React escapes them. */}
                <NotificationLink notification={n} role={role} onOpen={() => void open(n)} />
                <p className="mt-1 text-[0.875rem] text-ink-muted">{n.message}</p>
              </div>
              {!n.readAt && <Badge tone="info">New</Badge>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function NotificationLink({ notification, role, onOpen }: { notification: AppNotification; role: Role; onOpen: () => void }) {
  const to = notificationTarget(notification, role);
  if (!to) return <p className="font-semibold">{notification.title}</p>;
  return <Link to={to} onClick={onOpen} className="font-semibold text-ink">{notification.title}</Link>;
}

export function notificationTarget(n: AppNotification, role: Role): string | null {
  if (n.workOrderPublicId && role !== 'citizen') return `/work-orders/${encodeURIComponent(n.workOrderPublicId)}`;
  if (!n.complaintPublicId) return null;
  const id = encodeURIComponent(n.complaintPublicId);
  if (role === 'citizen') return `/citizen/complaints/${id}`;
  if (n.type === 'MANAGER_REVIEW_REQUIRED') return role === 'platform_admin' ? `/admin/triage/${id}` : `/manager/review/${id}`;
  if (role === 'platform_admin') return `/admin/triage/${id}`;
  return `/department/complaints/${id}`;
}
