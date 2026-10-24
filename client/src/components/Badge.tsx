import type { HTMLAttributes } from 'react';
import { cx } from '../lib/cx';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const toneClass: Record<BadgeTone, string> = {
  neutral: 'bg-surface-1 text-ink border border-hairline',
  info: 'bg-tag-blue-bg text-tag-blue-fg',
  success: 'bg-tag-green-bg text-tag-green-fg',
  warning: 'bg-tag-yellow-bg text-tag-yellow-fg border border-warning',
  error: 'bg-tag-red-bg text-tag-red-fg',
};

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cx('inline-flex min-h-6 items-center px-2 text-[0.75rem] tracking-[0.02em]', toneClass[tone], className)}
      {...rest}
    />
  );
}
