import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Button } from './Button';
import { Notification } from './Notification';

export function LoadingIndicator({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-[0.875rem] text-ink-muted" role="status" aria-live="polite">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-surface-2 border-t-primary" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <h2 className="text-[1.25rem]">{title}</h2>
      <p className="text-ink-muted">{description}</p>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'We could not complete that request. Try again.',
  onRetry,
}: {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <Notification kind="error" title={title}>
      <p>{description}</p>
      {onRetry && (
        <Button variant="tertiary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Notification>
  );
}
