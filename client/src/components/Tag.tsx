import { PRIORITY_META, STATUS_META, type ComplaintStatus, type Priority } from '../lib/domain';
import { cx } from '../lib/cx';

const toneClass = {
  gray: 'bg-tag-gray-bg text-tag-gray-fg',
  blue: 'bg-tag-blue-bg text-tag-blue-fg',
  cyan: 'bg-tag-cyan-bg text-tag-cyan-fg',
  purple: 'bg-tag-purple-bg text-tag-purple-fg',
  green: 'bg-tag-green-bg text-tag-green-fg',
  yellow: 'bg-tag-yellow-bg text-tag-yellow-fg border border-warning',
  red: 'bg-tag-red-bg text-tag-red-fg',
} as const;

const tagBase = 'inline-flex items-center min-h-6 px-2 text-[0.75rem] tracking-[0.02em] whitespace-nowrap';

/** Status is always shown as text, never by colour alone. */
export function StatusTag({ status }: { status: ComplaintStatus }) {
  const meta = STATUS_META[status];
  return <span className={cx(tagBase, toneClass[meta.tone])}>{meta.label}</span>;
}

const priorityClass: Record<Priority, string> = {
  P1: 'bg-error text-white',
  P2: 'bg-caution text-ink',
  P3: 'bg-warning text-ink',
  P4: 'bg-tag-gray-bg text-ink',
};

export function PriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) {
    return <span className={cx(tagBase, 'border border-hairline text-ink-muted')}>Priority pending</span>;
  }
  return (
    <span className={cx(tagBase, 'font-semibold', priorityClass[priority])} title={PRIORITY_META[priority].description}>
      {PRIORITY_META[priority].label}
    </span>
  );
}
