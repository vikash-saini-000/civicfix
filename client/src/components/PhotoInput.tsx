import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Button';

export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  onError?: (message: string | undefined) => void;
  error?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function PhotoInput({ files, onChange, onError, error, disabled = false, disabledReason }: Props) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | undefined>();
  const previews = useMemo(
    () => files.map((file) => (typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '')),
    [files],
  );

  useEffect(
    () => () => previews.filter(Boolean).forEach((preview) => URL.revokeObjectURL(preview)),
    [previews],
  );

  function reportError(message: string | undefined) {
    setLocalError(message);
    onError?.(message);
  }

  function add(list: FileList | null) {
    if (!list || disabled) return;
    const selected = Array.from(list);
    const invalidType = selected.find((file) => !file.type.startsWith('image/'));
    const invalidSize = selected.find((file) => file.size > MAX_PHOTO_BYTES);
    const available = MAX_PHOTOS - files.length;
    const validImages = selected.filter((file) => file.type.startsWith('image/') && file.size <= MAX_PHOTO_BYTES);

    if (available > 0 && validImages.length > 0) onChange([...files, ...validImages.slice(0, available)]);
    if (invalidType) reportError('Choose image files only.');
    else if (invalidSize) reportError('Each image must be 10 MB or smaller.');
    else if (validImages.length > available) reportError(`You can attach up to ${MAX_PHOTOS} photos.`);
    else reportError(undefined);
    if (inputRef.current) inputRef.current.value = '';
  }

  const messageId = `${id}-msg`;
  const effectiveError = error ?? localError;

  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="text-[0.75rem] tracking-[0.02em] text-ink-muted">
        Photos <span className="text-ink-subtle">(optional, up to {MAX_PHOTOS})</span>
      </span>
      <p className="text-[0.75rem] text-ink-muted">
        Images only, up to 10 MB each. Do not include private documents or unnecessary personal information.
      </p>
      {disabledReason && <p className="text-[0.75rem] text-ink-muted">{disabledReason}</p>}
      {files.length > 0 && (
        <ul className="grid max-w-md grid-cols-3 gap-2" aria-labelledby={`${id}-label`}>
          {files.map((file, index) => (
            <li key={`${file.name}-${file.size}-${index}`} className="relative border border-hairline bg-surface-1">
              {previews[index] ? (
                <img src={previews[index]} alt={`Photo ${index + 1}: ${file.name}`} className="aspect-square w-full object-cover" />
              ) : (
                <p className="aspect-square p-2 text-[0.75rem] text-ink-muted">{file.name}</p>
              )}
              <button
                type="button"
                onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))}
                className="absolute right-0 top-0 min-h-8 min-w-8 bg-inverse text-white hover:bg-[#393939]"
                aria-label={`Remove photo ${index + 1}`}
                disabled={disabled}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="mx-auto">
                  <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" />
                </svg>
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
            disabled={disabled}
            className="sr-only"
            onChange={(event) => add(event.target.files)}
            aria-labelledby={`${id}-label`}
            aria-describedby={effectiveError ? messageId : undefined}
          />
          <Button variant="tertiary" size="sm" onClick={() => inputRef.current?.click()} disabled={disabled}>
            {files.length ? 'Add another photo' : 'Add photos'}
          </Button>
        </div>
      )}
      {effectiveError && (
        <p id={messageId} className="text-[0.75rem] text-error" role="alert">
          {effectiveError}
        </p>
      )}
    </div>
  );
}
