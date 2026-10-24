import { useId, type ChangeEvent } from 'react';
import { cx } from '../lib/cx';

const fieldBase =
  'w-full bg-surface-1 text-ink border-0 border-b border-field-rule px-4 text-base placeholder:text-ink-subtle ' +
  'focus:outline-2 focus:-outline-offset-2 focus:outline-primary disabled:bg-surface-2 disabled:text-ink-subtle';

export function SearchInput({
  label,
  placeholder,
  value,
  onChange,
  onClear,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[0.75rem] tracking-[0.02em] text-ink-muted">{label}</label>
      <div className="relative">
        <input
          id={id}
          type="search"
          className={cx(fieldBase, 'min-h-12 pr-12')}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            className="absolute right-1 top-1 min-h-10 min-w-10 px-2 text-[0.75rem] text-primary hover:bg-surface-hover"
            aria-label={`Clear ${label.toLocaleLowerCase()}`}
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
