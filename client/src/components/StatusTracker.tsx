import { STATUS_META, TRACKER_STEPS, formatDateTime, type Complaint } from '../lib/domain';
import { cx } from '../lib/cx';
import { Notification } from './Notification';

/** Progress steps for the main path, plus an alert for paused, flagged or rejected states. */
export function StatusTracker({ complaint }: { complaint: Complaint }) {
  const { status, history } = complaint;
  const currentIndex = TRACKER_STEPS.findIndex((s) => s.statuses.includes(status));
  const latestNote = [...history].reverse().find((h) => h.status === status)?.note;

  return (
    <div className="flex flex-col gap-6">
      {status === 'REJECTED' ? (
        <Notification kind="error" title="This complaint was rejected">
          {latestNote ?? STATUS_META.REJECTED.citizenText}
        </Notification>
      ) : (
        <ol className="grid grid-cols-1 md:grid-cols-6" aria-label="Progress">
          {TRACKER_STEPS.map((step, i) => {
            const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
            const reachedAt = history.findLast((h) => step.statuses.includes(h.status))?.at;
            return (
              <li
                key={step.label}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cx(
                  'flex md:flex-col gap-3 md:gap-2 py-3 md:py-0 md:pr-4 md:pt-3 border-l-2 md:border-l-0 md:border-t-2 pl-4 md:pl-0',
                  state === 'todo' ? 'border-surface-2' : 'border-primary',
                )}
              >
                <StepIcon state={state} />
                <div>
                  <p className={cx('text-[0.875rem]', state === 'current' && 'font-semibold', state === 'todo' && 'text-ink-muted')}>
                    {step.label}
                    <span className="sr-only">
                      {state === 'done' ? ' (complete)' : state === 'current' ? ' (current step)' : ' (not started)'}
                    </span>
                  </p>
                  {reachedAt && state !== 'todo' && <p className="text-[0.75rem] text-ink-muted">{formatDateTime(reachedAt)}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {status === 'BLOCKED' && (
        <Notification kind="warning" title="Work is on hold">
          {latestNote ?? STATUS_META.BLOCKED.citizenText}
        </Notification>
      )}
      {status === 'VERIFICATION_REQUIRED' && (
        <Notification kind="warning" title="The fix is being double-checked">
          {latestNote ?? STATUS_META.VERIFICATION_REQUIRED.citizenText}
        </Notification>
      )}
    </div>
  );
}

function StepIcon({ state }: { state: 'done' | 'current' | 'todo' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 mt-1 md:mt-0">
      {state === 'done' && (
        <>
          <circle cx="8" cy="8" r="7" fill="#0f62fe" />
          <path d="M4.5 8.2l2.3 2.3 4.7-4.7" fill="none" stroke="#fff" strokeWidth="1.6" />
        </>
      )}
      {state === 'current' && (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="#0f62fe" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="3" fill="#0f62fe" />
        </>
      )}
      {state === 'todo' && <circle cx="8" cy="8" r="6.25" fill="none" stroke="#8d8d8d" strokeWidth="1.5" />}
    </svg>
  );
}

/** Full, time-ordered list of every status change. */
export function StatusHistory({ complaint }: { complaint: Complaint }) {
  const events = [...complaint.history].reverse();
  return (
    <ol className="border-t border-hairline">
      {events.map((e, i) => (
        <li key={`${e.status}-${e.at}-${i}`} className="grid grid-cols-[8rem_1fr] md:grid-cols-[12rem_1fr] gap-4 py-3 border-b border-hairline">
          <time dateTime={e.at} className="text-[0.75rem] text-ink-muted pt-0.5">
            {formatDateTime(e.at)}
          </time>
          <div>
            <p className="text-[0.875rem] font-semibold">{STATUS_META[e.status].label}</p>
            <p className="text-[0.875rem] text-ink-muted">{e.note ?? STATUS_META[e.status].citizenText}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
