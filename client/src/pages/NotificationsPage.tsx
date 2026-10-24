import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import { useOptionalAuth } from '../auth/AuthContext';
import { BackendNotifications } from '../components/BackendNotifications';
import { Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { StatusTag } from '../components/Tag';
import { complaintLoadErrorMessage } from '../lib/complaints';
import { buildComplaintActivity, type ComplaintActivity } from '../lib/activity';
import { formatDateTime, getStatusMeta } from '../lib/domain';
import { useRefreshOnActivity } from '../lib/refresh';

interface NotificationsPageProps {
  complaintApi?: ComplaintApi;
}

export function NotificationsPage({ complaintApi = api }: NotificationsPageProps) {
  const auth = useOptionalAuth();
  const role = auth?.state.user?.role;
  if (complaintApi.capabilities?.operations && role) {
    return (
      <Page title="Notifications" intro="Updates about your complaints and work, newest first.">
        <BackendNotifications role={role} />
      </Page>
    );
  }
  return <ComplaintActivityFeed complaintApi={complaintApi} />;
}

/** Mock-mode fallback: derives activity from the citizen's complaint history. */
function ComplaintActivityFeed({ complaintApi }: { complaintApi: ComplaintApi }) {
  const auth = useOptionalAuth();
  const refreshSession = auth?.refreshSession;
  const isCitizen = auth?.state.user?.role === 'citizen';
  const [activities, setActivities] = useState<ComplaintActivity[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);
  useRefreshOnActivity(refresh, { enabled: isCitizen });

  useEffect(() => {
    if (!isCitizen) {
      setActivities(null);
      setErrorMessage(null);
      return;
    }

    const controller = new AbortController();
    setActivities(null);
    setErrorMessage(null);
    complaintApi
      .listMyComplaints(controller.signal)
      .then((complaints) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(complaints)) {
          setErrorMessage('The complaint service returned an unexpected response. Please try again.');
          return;
        }
        setActivities(buildComplaintActivity(complaints));
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
  }, [complaintApi, isCitizen, refreshSession, reloadToken]);

  if (!isCitizen) {
    return (
      <NotificationUnavailable
        explanation="This account does not have a citizen-safe complaint activity feed in the current API contract. Staff and administrator notifications require their own authorized notification endpoint."
      />
    );
  }

  if (!activities && !errorMessage) {
    return (
      <Page title="Notifications" intro="Recent public status activity from your complaints.">
        <LoadingIndicator label="Loading recent complaint activity" />
      </Page>
    );
  }

  if (errorMessage) {
    return (
      <Page title="Notifications" intro="Recent public status activity from your complaints.">
        <div className="max-w-2xl">
          <ErrorState title="We could not load recent activity" description={errorMessage} onRetry={refresh} />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Notifications" intro="Recent public status activity from your complaints.">
      <Notification kind="info" title="Persistent notifications are not configured">
        This view shows the public complaint history already returned by the current API. It does not invent unread counts,
        read states, delivery events, or staff-only activity.
      </Notification>
      <Card className="mt-8">
        {!activities?.length ? (
          <EmptyState
            title="No public activity yet"
            description="Updates from your complaints will appear here after the service provides public status history."
          />
        ) : (
          <>
            <p className="mb-4 text-[0.875rem] text-ink-muted" role="status" aria-live="polite">
              Showing {activities.length} recent public update{activities.length === 1 ? '' : 's'}.
            </p>
            <ol className="border-t border-hairline" aria-label="Recent complaint activity">
              {activities.map((activity) => <ActivityRow key={activity.id} activity={activity} />)}
            </ol>
          </>
        )}
      </Card>
    </Page>
  );
}

function ActivityRow({ activity }: { activity: ComplaintActivity }) {
  const statusMeta = getStatusMeta(activity.status);
  return (
    <li className="grid gap-2 border-b border-hairline py-4 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
      <time dateTime={activity.at} className="text-[0.75rem] text-ink-muted">{formatDateTime(activity.at)}</time>
      <div className="min-w-0">
        <Link to={`/citizen/complaints/${encodeURIComponent(activity.complaintId)}`} className="font-semibold text-ink">
          {activity.complaintTitle}
        </Link>
        <p className="mt-1 text-[0.875rem] text-ink-muted">{activity.note ?? `Status changed to ${statusMeta.label}.`}</p>
      </div>
      <StatusTag status={activity.status} />
    </li>
  );
}

function NotificationUnavailable({ explanation }: { explanation: string }) {
  return (
    <Page title="Notifications" intro="Notification delivery and read state require an implemented backend contract.">
      <Card className="max-w-2xl">
        <Notification kind="info" title="Notifications are not available for this account yet">
          <p>{explanation}</p>
          <p className="mt-3">No private activity, fake notifications, or unread counts are displayed.</p>
        </Notification>
        <Link to="/" className="mt-5 inline-flex min-h-12 items-center text-primary">← Return home</Link>
      </Card>
    </Page>
  );
}
