import { formatDateTime, getStatusMeta, isKnownComplaintStatus, type Complaint } from '../lib/domain';
import { Notification } from './Notification';
import { StatusTag } from './Tag';

/** Current status summary. Historical events are rendered separately and never inferred here. */
export function StatusTracker({ complaint }: { complaint: Complaint }) {
  const { status } = complaint;
  const history = Array.isArray(complaint.history) ? complaint.history : [];
  const latestNote = history
    .filter((event) => event.status === status)
    .sort((a, b) => timestampValue(b.at) - timestampValue(a.at))[0]?.note;
  const statusMeta = getStatusMeta(status);

  return (
    <div className="flex flex-col gap-6">
      <div className="border border-hairline bg-surface-1 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusTag status={status} />
          <span className="text-[0.75rem] text-ink-muted">Updated {formatDateTime(complaint.updatedAt)}</span>
        </div>
      </div>

      {status === 'REJECTED' ? (
        <Notification kind="error" title="This complaint was rejected">
          {latestNote ?? statusMeta.citizenText}
        </Notification>
      ) : !isKnownComplaintStatus(status) ? (
        <Notification kind="info" title={statusMeta.label}>
          {latestNote ?? statusMeta.citizenText}
        </Notification>
      ) : history.length === 0 ? (
        <Notification kind="info" title="No public status history yet">
          The current status is available, but the service has not provided a public history for this complaint.
        </Notification>
      ) : null}

      {status === 'BLOCKED' && (
        <Notification kind="warning" title="Work is on hold">
          {latestNote ?? statusMeta.citizenText}
        </Notification>
      )}
      {status === 'VERIFICATION_REQUIRED' && (
        <Notification kind="warning" title="The fix is being double-checked">
          {latestNote ?? statusMeta.citizenText}
        </Notification>
      )}
    </div>
  );
}

/** Full, time-ordered list of every status change. */
export function StatusHistory({ complaint }: { complaint: Complaint }) {
  const events = Array.isArray(complaint.history)
    ? deduplicateEvents(complaint.history)
        .map((event, index) => ({ event, index }))
        .sort((a, b) => timestampValue(b.event.at) - timestampValue(a.event.at) || b.index - a.index)
        .map(({ event }) => event)
    : [];
  if (events.length === 0) {
    return <p className="border-t border-hairline pt-4 text-[0.875rem] text-ink-muted">No public status history is available yet.</p>;
  }

  return (
    <ol className="border-t border-hairline" aria-label="Public complaint status history">
      {events.map((e, i) => (
        <li key={`${e.status}-${e.at}-${i}`} className="grid gap-2 border-b border-hairline py-3 sm:grid-cols-[8rem_1fr] sm:gap-4 md:grid-cols-[12rem_1fr]">
          <time dateTime={e.at} className="text-[0.75rem] text-ink-muted pt-0.5">
            {formatDateTime(e.at)}
          </time>
          <div>
            <p className="text-[0.875rem] font-semibold">{getStatusMeta(e.status).label}</p>
            {e.note && <p className="text-[0.875rem] text-ink-muted">{e.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function deduplicateEvents(events: NonNullable<Complaint['history']>) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.status}\u0000${event.at}\u0000${event.note ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
