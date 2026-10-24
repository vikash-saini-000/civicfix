import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import type { ComplaintAnalysis, Evidence, EvidencePurpose, WorkOrderStatus } from '../api/operationsTypes';
import { categoryLabel, formatDateTime, getPriorityMeta } from '../lib/domain';
import { cx } from '../lib/cx';
import { useAction, useResource } from '../lib/useResource';
import {
  ACCEPTED_UPLOAD_TYPES,
  AUTHENTICITY_LABELS,
  EVIDENCE_PURPOSE_LABELS,
  formatDistance,
  reviewReasonLabel,
  workOrderStatusMeta,
} from '../lib/workflow';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { ErrorState, LoadingIndicator } from './Feedback';
import { TextArea, TextInput } from './Field';
import { Notification } from './Notification';

const toneClass = {
  gray: 'bg-tag-gray-bg text-tag-gray-fg',
  blue: 'bg-tag-blue-bg text-tag-blue-fg',
  cyan: 'bg-tag-cyan-bg text-tag-cyan-fg',
  purple: 'bg-tag-purple-bg text-tag-purple-fg',
  green: 'bg-tag-green-bg text-tag-green-fg',
  yellow: 'bg-tag-yellow-bg text-tag-yellow-fg border border-warning',
  red: 'bg-tag-red-bg text-tag-red-fg',
} as const;

export function WorkOrderStatusTag({ status }: { status: WorkOrderStatus }) {
  const meta = workOrderStatusMeta(status);
  return <span className={cx('inline-flex min-h-6 items-center whitespace-nowrap px-2 text-[0.75rem] tracking-[0.02em]', toneClass[meta.tone])}>{meta.label}</span>;
}

export function ReviewReasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Review reasons">
      {reasons.map((reason) => (
        <li key={reason}>
          <Badge tone={reason === 'PUBLIC_SAFETY_HAZARD' || reason === 'HIGH_URGENCY' ? 'error' : 'warning'}>{reviewReasonLabel(reason)}</Badge>
        </li>
      ))}
    </ul>
  );
}

export function MetricTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card className="border-0 bg-canvas">
      <p className="text-[0.75rem] text-ink-muted">{label}</p>
      <p className="mt-2 text-[2rem] font-semibold leading-none">{value}</p>
      {hint && <p className="mt-2 text-[0.75rem] text-ink-muted">{hint}</p>}
    </Card>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

/**
 * A small inline form for actions that need a written reason. Shown on demand so the page
 * doesn't fill up with open text boxes.
 */
export function ReasonAction({
  label,
  submitLabel,
  fieldLabel = 'Reason',
  helper,
  minLength = 3,
  variant = 'tertiary',
  extraField,
  onSubmit,
}: {
  label: string;
  submitLabel?: string;
  fieldLabel?: string;
  helper?: string;
  minLength?: number;
  variant?: 'primary' | 'tertiary' | 'danger' | 'secondary';
  /** Optional second required text field (e.g. "next action" when blocking work). */
  extraField?: { label: string; minLength: number };
  onSubmit: (reason: string, extra: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [extra, setExtra] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < minLength) return setFieldError(`Write at least ${minLength} characters.`);
    if (extraField && extra.trim().length < extraField.minLength) return setFieldError(`${extraField.label}: write at least ${extraField.minLength} characters.`);
    setFieldError(null);
    const ok = await run(async () => {
      await onSubmit(reason.trim(), extra.trim());
      return true;
    });
    if (ok) {
      setOpen(false);
      setReason('');
      setExtra('');
    }
  }

  if (!open) {
    return (
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3 border border-hairline p-4" noValidate>
      <p className="font-semibold">{label}</p>
      {error && <Notification kind="error" title={error} />}
      <TextArea label={fieldLabel} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} helper={helper} error={fieldError ?? undefined} required />
      {extraField && <TextInput label={extraField.label} value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={1000} required />}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant={variant === 'tertiary' ? 'primary' : variant} size="sm" disabled={busy}>
          {busy ? 'Saving…' : submitLabel ?? label}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Evidence list with access-checked image previews and an optional upload control. */
export function EvidencePanel({
  publicId,
  uploadPurpose,
  uploadLabel = 'Add a photo',
  showAuthenticity = false,
  filter,
  onUploaded,
  refreshKey = 0,
  title = 'Photos and evidence',
}: {
  publicId: string;
  uploadPurpose?: EvidencePurpose;
  uploadLabel?: string;
  showAuthenticity?: boolean;
  filter?: (evidence: Evidence) => boolean;
  onUploaded?: (evidence: Evidence) => void;
  refreshKey?: number;
  title?: string;
}) {
  const evidence = useResource((signal) => api.listEvidence(publicId, signal), [publicId, refreshKey]);
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, error, setError, run } = useAction();
  const items = (evidence.data ?? []).filter(filter ?? (() => true));

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file || !uploadPurpose) return;
    if (!ACCEPTED_UPLOAD_TYPES.includes(file.type)) return setError('Choose a JPEG, PNG or WebP image.');
    if (file.size > 10 * 1024 * 1024) return setError('The image must be 10 MB or smaller.');
    const created = await run(() => api.uploadEvidence(publicId, file, uploadPurpose));
    if (created) {
      onUploaded?.(created);
      evidence.reload();
    }
  }

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="text-[1rem] font-semibold">{title}</h3>
      {evidence.loading && !evidence.data && <LoadingIndicator label="Loading evidence" />}
      {evidence.error && <ErrorState title="Evidence could not be loaded" description={evidence.error} onRetry={evidence.reload} />}
      {evidence.data && items.length === 0 && <p className="text-[0.875rem] text-ink-muted">No files yet.</p>}
      {items.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => (
            <li key={item.id} className="border border-hairline bg-surface-1">
              <EvidencePreview evidence={item} />
              <div className="p-2 text-[0.75rem]">
                <p className="font-semibold">{EVIDENCE_PURPOSE_LABELS[item.purpose] ?? item.purpose}</p>
                {item.caption && <p className="text-ink-muted">{item.caption}</p>}
                <p className="text-ink-muted">{formatDateTime(item.createdAt)}</p>
                {showAuthenticity && item.authenticity && (
                  <Badge tone={item.authenticity === 'NO_SUSPICIOUS_SIGNALS_DETECTED' ? 'success' : item.authenticity.startsWith('POTENTIAL') ? 'error' : 'neutral'} className="mt-1">
                    {AUTHENTICITY_LABELS[item.authenticity] ?? item.authenticity}
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {uploadPurpose && (
        <div>
          {error && <Notification kind="error" title={error} className="mb-3" />}
          <input ref={inputRef} type="file" accept={ACCEPTED_UPLOAD_TYPES.join(',')} className="sr-only" aria-label={uploadLabel} onChange={(e) => void upload(e.target.files)} />
          <Button variant="tertiary" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : uploadLabel}
          </Button>
        </div>
      )}
    </section>
  );
}

function EvidencePreview({ evidence }: { evidence: Evidence }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (evidence.mediaType !== 'IMAGE') return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    api
      .fetchEvidenceContent(evidence.id, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted || typeof URL.createObjectURL !== 'function') return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [evidence.id, evidence.mediaType]);

  if (url) return <img src={url} alt={evidence.caption ?? 'Evidence photo'} className="aspect-square w-full object-cover" />;
  return (
    <div className="flex aspect-square items-center justify-center p-2 text-center text-[0.75rem] text-ink-muted">
      {evidence.mediaType === 'VIDEO' ? 'Video file' : failed ? 'Preview unavailable' : 'Loading preview…'}
    </div>
  );
}

/** AI suggestion, duplicates and photo checks for staff. Advice only: humans decide. */
export function AnalysisPanel({ publicId, refreshKey = 0 }: { publicId: string; refreshKey?: number }) {
  const analysis = useResource((signal) => api.getAnalysis(publicId, signal), [publicId, refreshKey]);
  if (analysis.loading && !analysis.data) return <LoadingIndicator label="Loading AI analysis" />;
  if (analysis.error) {
    return <ErrorState title="AI analysis could not be loaded" description={analysis.error} onRetry={analysis.reload} />;
  }
  if (!analysis.data) return null;
  return <AnalysisDetails analysis={analysis.data} onRefresh={analysis.reload} />;
}

function AnalysisDetails({ analysis, onRefresh }: { analysis: ComplaintAnalysis; onRefresh: () => void }) {
  const c = analysis.classification;
  const running = c.status === 'PENDING' || c.status === 'RUNNING';
  return (
    <Card className="flex flex-col gap-4 bg-surface-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[1.125rem]">AI analysis</h3>
        <Badge tone="info">Advice only</Badge>
      </div>
      {!analysis.aiEnabled && <p className="text-[0.875rem] text-ink-muted">AI is switched off on this server. Route this case manually.</p>}
      {running && (
        <div className="flex flex-wrap items-center gap-3">
          <LoadingIndicator label="AI is analysing this report" />
          <Button variant="ghost" size="sm" onClick={onRefresh}>Check again</Button>
        </div>
      )}
      {(c.status === 'FAILED' || c.status === 'INVALID_OUTPUT') && (
        <p className="text-[0.875rem] text-ink-muted">AI classification did not finish ({c.errorCode ?? c.status}). Route this case manually.</p>
      )}
      {c.status === 'SUCCEEDED' && c.suggestion && (
        <>
          {c.summary && <p>{c.summary}</p>}
          <dl className="grid gap-x-4 gap-y-2 text-[0.875rem] sm:grid-cols-[9rem_1fr]">
            <dt className="text-ink-muted">Category</dt>
            <dd>{categoryLabel(c.suggestion.category)}</dd>
            <dt className="text-ink-muted">Department</dt>
            <dd>{c.suggestion.department?.name ?? 'No clear department'}</dd>
            <dt className="text-ink-muted">Priority</dt>
            <dd>{c.suggestion.priority ? getPriorityMeta(c.suggestion.priority).label : 'Not suggested'}</dd>
            <dt className="text-ink-muted">Certainty</dt>
            <dd>{c.certainty ?? 'Unknown'} <span className="text-ink-muted">(the model's own estimate)</span></dd>
            {c.agent?.proposedAssignee && (
              <>
                <dt className="text-ink-muted">Suggested staff</dt>
                <dd>{c.agent.proposedAssignee.name}</dd>
              </>
            )}
          </dl>
          {c.rationale && <p className="text-[0.875rem] text-ink-muted">{c.rationale}</p>}
          {c.missingInformation && c.missingInformation.length > 0 && (
            <div className="text-[0.875rem]">
              <p className="font-semibold">Missing information</p>
              <ul className="list-disc pl-5 text-ink-muted">{c.missingInformation.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          )}
          {c.reviewReasons && <ReviewReasons reasons={c.reviewReasons} />}
        </>
      )}
      <div className="text-[0.875rem]">
        <p className="font-semibold">Possible duplicates</p>
        {analysis.duplicates.status !== 'SUCCEEDED' ? (
          <p className="text-ink-muted">Duplicate check: {analysis.duplicates.status.toLowerCase().replaceAll('_', ' ')}.</p>
        ) : !analysis.duplicates.candidates?.length ? (
          <p className="text-ink-muted">No similar reports nearby.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {analysis.duplicates.candidates.map((d) => (
              <li key={d.publicId} className="border-l-2 border-hairline pl-3">
                <span className="font-mono">{d.publicId}</span> · {d.title}
                <span className="block text-ink-muted">{formatDistance(d.distanceMeters)} away · {Math.round(d.similarity * 100)}% similar wording · {d.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {analysis.media.some((m) => m.comparison && m.comparison.status === 'DONE') && (
        <div className="text-[0.875rem]">
          <p className="font-semibold">Before/after photo comparison</p>
          <ul className="mt-1 flex flex-col gap-1 text-ink-muted">
            {analysis.media.filter((m) => m.comparison?.status === 'DONE').map((m) => (
              <li key={m.evidenceId}>
                Same place: {m.comparison!.sameLocation} · Looks fixed: {m.comparison!.issueAppearsFixed} · Matches category: {m.comparison!.matchesCategory}
                {m.comparison!.notes && <span className="block">{m.comparison!.notes}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
