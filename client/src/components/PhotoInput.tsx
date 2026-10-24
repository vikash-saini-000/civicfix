import { useEffect, useId, useMemo, useRef } from 'react';
import { Button } from './Button';

export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  error?: string;
}

export function PhotoInput({ files, onChange, error }: Props) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);

  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(list: FileList | null) {
    if (!list) return;
    const images = Array.from(list).filter((f) => f.type.startsWith('image/'));
    onChange([...files, ...images].slice(0, MAX_PHOTOS));
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="text-[0.75rem] tracking-[0.02em] text-ink-muted">
        Photos <span className="text-ink-subtle">(optional, up to {MAX_PHOTOS})</span>
      </span>
      <p className="text-[0.75rem] text-ink-muted">
        A clear photo helps the team find and fix the problem. Faces and number plates are blurred before anyone sees them.
      </p>
      {files.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 max-w-md" aria-labelledby={`${id}-label`}>
          {files.map((f, i) => (
            <li key={previews[i]} className="relative border border-hairline bg-surface-1">
              <img src={previews[i]} alt={`Photo ${i + 1}: ${f.name}`} className="aspect-square w-full object-cover" />
              <button
                type="button"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="absolute top-0 right-0 min-h-8 min-w-8 bg-inverse text-white text-[0.75rem] hover:bg-[#393939]"
                aria-label={`Remove photo ${i + 1}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length < MAX_PHOTOS && (
        <div>
          <input
            ref={inputRef}
            id={id}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => add(e.target.files)}
            aria-describedby={error ? `${id}-err` : undefined}
          />
          <Button variant="tertiary" size="sm" onClick={() => inputRef.current?.click()}>
            {files.length ? 'Add another photo' : 'Add photos'}
          </Button>
        </div>
      )}
      {error && (
        <p id={`${id}-err`} className="text-[0.75rem] text-error">
          {error}
        </p>
      )}
    </div>
  );
}
