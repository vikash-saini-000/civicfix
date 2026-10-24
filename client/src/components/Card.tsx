import type { HTMLAttributes } from 'react';
import { cx } from '../lib/cx';

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={cx('border border-hairline bg-canvas p-6', className)} {...rest} />;
}
