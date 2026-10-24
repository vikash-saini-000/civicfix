import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../lib/cx';

// Carbon-style field: grey fill, bottom rule, blue inset outline on focus, red outline on error.
const fieldBase =
  'w-full bg-surface-1 text-ink border-0 border-b border-field-rule px-4 text-base placeholder:text-ink-subtle ' +
  'focus:outline-2 focus:-outline-offset-2 focus:outline-primary disabled:bg-surface-2 disabled:text-ink-subtle';
const fieldError = 'outline-2 -outline-offset-2 outline-error';

const chevron =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6l.7-.7L8 9.6l4.3-4.3.7.7z' fill='%23161616'/%3E%3C/svg%3E\")";

interface WrapperProps {
  id: string;
  label: string;
  optional?: boolean;
  helper?: ReactNode;
  error?: string;
  children: ReactNode;
}

function FieldWrapper({ id, label, optional, helper, error, children }: WrapperProps) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[0.75rem] tracking-[0.02em] text-ink-muted">
        {label}
        {optional && <span className="text-ink-subtle"> (optional)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-[0.75rem] text-error">
          {error}
        </p>
      ) : helper ? (
        <p id={`${id}-msg`} className="text-[0.75rem] text-ink-muted">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

type Common = { label: string; optional?: boolean; helper?: ReactNode; error?: string };

function describedBy(id: string, error?: string, helper?: ReactNode) {
  return error || helper ? `${id}-msg` : undefined;
}

export function TextInput({ label, optional, helper, error, className, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldWrapper id={id} label={label} optional={optional} helper={helper} error={error}>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, helper)}
        className={cx(fieldBase, 'min-h-12', error && fieldError, className)}
        {...rest}
      />
    </FieldWrapper>
  );
}

export function TextArea({ label, optional, helper, error, className, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldWrapper id={id} label={label} optional={optional} helper={helper} error={error}>
      <textarea
        id={id}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, helper)}
        className={cx(fieldBase, 'min-h-32 py-3 resize-y', error && fieldError, className)}
        {...rest}
      />
    </FieldWrapper>
  );
}

export function Select({ label, optional, helper, error, className, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldWrapper id={id} label={label} optional={optional} helper={helper} error={error}>
      <select
        id={id}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, helper)}
        className={cx(fieldBase, 'min-h-12 appearance-none bg-no-repeat pr-10', error && fieldError, className)}
        style={{ backgroundImage: chevron, backgroundSize: '16px', backgroundPosition: 'right 1rem center' }}
        {...rest}
      >
        {children}
      </select>
    </FieldWrapper>
  );
}
