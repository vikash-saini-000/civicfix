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
  required?: boolean;
  optional?: boolean;
  helper?: ReactNode;
  error?: string;
  children: ReactNode;
}

function FieldWrapper({ id, label, required, optional, helper, error, children }: WrapperProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <label htmlFor={id} className="text-[0.75rem] tracking-[0.02em] text-ink-muted">{label}</label>
        {required ? <span className="text-[0.75rem] text-ink-subtle">Required</span> : optional && <span className="text-[0.75rem] text-ink-subtle">(optional)</span>}
      </div>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-[0.75rem] text-error" role="alert">
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

type Common = { label: string; required?: boolean; optional?: boolean; helper?: ReactNode; error?: string };

function describedBy(id: string, error?: string, helper?: ReactNode) {
  return error || helper ? `${id}-msg` : undefined;
}

export function TextInput({ label, required, optional, helper, error, className, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldWrapper id={id} label={label} required={required} optional={optional} helper={helper} error={error}>
      <input
        id={id}
        required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, helper)}
        aria-errormessage={error ? `${id}-msg` : undefined}
        className={cx(fieldBase, 'min-h-12', error && fieldError, className)}
        {...rest}
      />
    </FieldWrapper>
  );
}

export function TextArea({ label, required, optional, helper, error, className, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldWrapper id={id} label={label} required={required} optional={optional} helper={helper} error={error}>
      <textarea
        id={id}
        required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, helper)}
        aria-errormessage={error ? `${id}-msg` : undefined}
        className={cx(fieldBase, 'min-h-32 py-3 resize-y', error && fieldError, className)}
        {...rest}
      />
    </FieldWrapper>
  );
}

export function Select({ label, required, optional, helper, error, className, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldWrapper id={id} label={label} required={required} optional={optional} helper={helper} error={error}>
      <select
        id={id}
        required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, error, helper)}
        aria-errormessage={error ? `${id}-msg` : undefined}
        className={cx(fieldBase, 'min-h-12 appearance-none bg-no-repeat pr-10', error && fieldError, className)}
        style={{ backgroundImage: chevron, backgroundSize: '16px', backgroundPosition: 'right 1rem center' }}
        {...rest}
      >
        {children}
      </select>
    </FieldWrapper>
  );
}

export function Checkbox({ label, required, helper, error, className, ...rest }: Omit<Common, 'optional'> & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex min-h-12 items-center gap-3 text-[0.875rem] text-ink">
        <input
          id={id}
          type="checkbox"
          required={required}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, error, helper)}
          aria-errormessage={error ? `${id}-msg` : undefined}
          className={cx('h-5 w-5 accent-primary', error && fieldError, className)}
          {...rest}
        />
        <span>{label}{required && <span className="text-ink-subtle"> (required)</span>}</span>
      </label>
      {error ? (
        <p id={`${id}-msg`} className="text-[0.75rem] text-error" role="alert">
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

interface RadioOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function RadioGroup({
  label,
  value,
  options,
  onChange,
  helper,
  error,
  name,
}: {
  label: string;
  value?: string;
  options: RadioOption[];
  onChange: (value: string) => void;
  helper?: ReactNode;
  error?: string;
  name?: string;
}) {
  const groupId = useId();
  const groupName = name ?? groupId;
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={describedBy(groupId, error, helper)}>
      <legend className="text-[0.75rem] tracking-[0.02em] text-ink-muted">{label}</legend>
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-12 items-center gap-3 text-[0.875rem] text-ink">
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
              className="h-5 w-5 accent-primary"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p id={`${groupId}-msg`} className="text-[0.75rem] text-error">
          {error}
        </p>
      ) : helper ? (
        <p id={`${groupId}-msg`} className="text-[0.75rem] text-ink-muted">
          {helper}
        </p>
      ) : null}
    </fieldset>
  );
}
