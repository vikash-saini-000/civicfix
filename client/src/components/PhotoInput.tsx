import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useCapturePolicy } from '../lib/capture';
import { ACCEPTED_MEDIA_TYPES, isVideoFile, MAX_IMAGE_BYTES, mediaFileError } from '../lib/media';
import { Button } from './Button';
import { CameraCapture } from './CameraCapture';

/** Photos and videos per report. */
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = MAX_IMAGE_BYTES;

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
  const [cameraOpen, setCameraOpen] = useState(false);
  const policy = useCapturePolicy();
  // Until the policy is known, assume the strict rule (camera only) so the gallery never flashes up.
  const cameraOnly = policy?.captureMode !== 'any';
  const maxVideoSeconds = policy?.maxVideoSeconds ?? 60;
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
    const firstProblem = selected.map(mediaFileError).find(Boolean);
    const available = MAX_PHOTOS - files.length;
    const valid = selected.filter((file) => !mediaFileError(file));

    if (available > 0 && valid.length > 0) onChange([...files, ...valid.slice(0, available)]);
    if (firstProblem) reportError(firstProblem);
    else if (valid.length > available) reportError(`You can attach up to ${MAX_PHOTOS} photos or videos.`);
    else reportError(undefined);
    if (inputRef.current) inputRef.current.value = '';
  }

  function captured(file: File) {
    setCameraOpen(false);
    const problem = mediaFileError(file);
    if (problem) return reportError(problem);
    if (files.length >= MAX_PHOTOS) return reportError(`You can attach up to ${MAX_PHOTOS} photos or videos.`);
    onChange([...files, file]);
    reportError(undefined);
  }

  const messageId = `${id}-msg`;
  const helpId = `${id}-help`;
  const effectiveError = error ?? localError;

  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="text-[0.75rem] tracking-[0.02em] text-ink-muted">
        Photos or videos <span className="text-ink-subtle">(optional, up to {MAX_PHOTOS})</span>
      </span>
      <p id={helpId} className="text-[0.75rem] text-ink-muted">
        {cameraOnly
          ? `Take them now with your camera at the location (videos up to ${maxVideoSeconds} seconds). The time and your location are recorded with each one.`
          : `Take them with your camera, or choose files: photos (JPEG, PNG, WebP) up to 10 MB, videos (MP4, MOV) up to 50 MB and ${maxVideoSeconds} seconds.`}{' '}
        Do not include private documents or unnecessary personal information.
      </p>
      {disabledReason && <p className="text-[0.75rem] text-ink-muted">{disabledReason}</p>}
      {files.length > 0 && (
        <ul className="grid max-w-md grid-cols-3 gap-2" aria-labelledby={`${id}-label`}>
          {files.map((file, index) => (
            <li key={`${file.name}-${file.size}-${index}`} className="relative border border-hairline bg-surface-1">
              {previews[index] && isVideoFile(file) ? (
                <video src={previews[index]} muted playsInline preload="metadata" aria-label={`Video ${index + 1}: ${file.name}`} className="aspect-square w-full bg-black object-cover" />
              ) : previews[index] ? (
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
        <div className="flex flex-wrap gap-2">
          <Button variant="tertiary" size="sm" onClick={() => setCameraOpen(true)} disabled={disabled || !policy} aria-describedby={helpId}>
            {files.length ? 'Take another photo or video' : 'Take a photo or video'}
          </Button>
          {!cameraOnly && (
            <>
              <input
                ref={inputRef}
                id={id}
                type="file"
                accept={ACCEPTED_MEDIA_TYPES.join(',')}
                multiple
                disabled={disabled}
                className="sr-only"
                onChange={(event) => add(event.target.files)}
                aria-labelledby={`${id}-label`}
                aria-describedby={effectiveError ? `${helpId} ${messageId}` : helpId}
                aria-invalid={Boolean(effectiveError)}
              />
              <Button variant="ghost" size="sm" onClick={() => inputRef.current?.click()} disabled={disabled}>
                {files.length ? 'Add another file' : 'Choose files'}
              </Button>
            </>
          )}
        </div>
      )}
      {cameraOpen && <CameraCapture maxVideoSeconds={maxVideoSeconds} onCapture={captured} onClose={() => setCameraOpen(false)} />}
      {effectiveError && (
          <p id={messageId} className="text-[0.75rem] text-error" role="alert">
          {effectiveError}
        </p>
      )}
    </div>
  );
}
