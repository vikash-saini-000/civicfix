import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

type Kind = 'info' | 'success' | 'warning' | 'error';

const kindClass: Record<Kind, string> = {
  info: 'border-l-info bg-[#edf5ff]',
  success: 'border-l-success bg-[#defbe6]',
  warning: 'border-l-warning bg-[#fcf4d6]',
  error: 'border-l-error bg-[#fff1f1]',
};

const kindLabel: Record<Kind, string> = { info: 'Info', success: 'Success', warning: 'Warning', error: 'Error' };

export function Notification({
  kind,
  title,
  children,
  className,
}: {
  kind: Kind;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cx('border-l-[3px] px-4 py-3 text-[0.875rem] text-ink', kindClass[kind], className)}
    >
      <span className="sr-only">{kindLabel[kind]}: </span>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}
