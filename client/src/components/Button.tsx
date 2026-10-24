import type { ButtonHTMLAttributes } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cx } from '../lib/cx';

type Variant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'danger';
type Size = 'md' | 'sm';

const base =
  'inline-flex items-center justify-center gap-2 px-4 text-[0.875rem] font-normal tracking-[0.01em] no-underline ' +
  'transition-colors duration-100 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-subtle disabled:border-transparent';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active',
  secondary: 'bg-[#393939] text-white hover:bg-[#474747] active:bg-[#6f6f6f]',
  tertiary:
    'border border-primary text-primary bg-transparent hover:bg-primary hover:text-on-primary active:bg-primary-active',
  ghost: 'text-primary bg-transparent hover:bg-surface-hover active:bg-surface-2',
  danger: 'bg-error text-white hover:bg-[#b81921] active:bg-[#750e13]',
};

const sizes: Record<Size, string> = {
  md: 'min-h-12',
  sm: 'min-h-10',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra?: string) {
  return cx(base, variants[variant], sizes[size], extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

interface ButtonLinkProps extends Omit<LinkProps, 'className'> {
  variant?: Variant;
  size?: Size;
  className?: string;
}

export function ButtonLink({ variant = 'primary', size = 'md', className, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}
