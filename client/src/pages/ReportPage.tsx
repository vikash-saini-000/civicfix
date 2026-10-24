import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { Button } from '../components/Button';
import { Select, TextArea, TextInput } from '../components/Field';
import { Page } from '../components/Layout';
import { LocationPicker } from '../components/LocationPicker';
import { Notification } from '../components/Notification';
import { MAX_PHOTO_BYTES, PhotoInput } from '../components/PhotoInput';
import { CATEGORIES, type CategoryId, type GeoPoint } from '../lib/domain';

type Errors = Partial<Record<'title' | 'description' | 'location' | 'photos', string>>;

const TITLE_MAX = 120;
const DESC_MAX = 2000;

export function ReportPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<CategoryId | ''>('');
  const [landmark, setLandmark] = useState('');
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  // After a failed submit, move focus to the error summary once it has rendered.
  useEffect(() => {
    if (failedAttempts > 0) summaryRef.current?.focus();
  }, [failedAttempts]);

  function validate(): Errors {
    const e: Errors = {};
    if (title.trim().length < 5) e.title = 'Give the problem a short title (at least 5 characters).';
    if (description.trim().length < 10) e.description = 'Describe the problem in a sentence or two (at least 10 characters).';
    if (!location) e.location = 'Place a pin on the map so the team can find it.';
    if (photos.some((p) => p.size > MAX_PHOTO_BYTES)) e.photos = 'Each photo must be 10 MB or smaller.';
    return e;
  }

  async function onSubmit(ev: SubmitEvent<HTMLFormElement>) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) {
      setFailedAttempts((n) => n + 1);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api.submitComplaint({
        title,
        description,
        location: location!,
        landmark,
        selectedCategory: category || null,
        photos,
      });
      navigate(`/complaints/${created.publicId}`, { state: { justSubmitted: true } });
    } catch {
      setSubmitError('Your complaint was not sent. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  const errorMessages = Object.values(errors).filter((m): m is string => Boolean(m));
  const errorCount = errorMessages.length;

  return (
    <Page
      title="Report a problem"
      intro="Tell us what is wrong and where. You can write in English, Hindi or Kannada. We will sort it to the right department and keep you updated."
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6 max-w-[42rem]">
          {errorCount > 0 && (
            <div ref={summaryRef} tabIndex={-1}>
              <Notification kind="error" title={`Please fix ${errorCount === 1 ? '1 field' : `${errorCount} fields`} below`}>
                <ul className="list-disc pl-5">
                  {errorMessages.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </Notification>
            </div>
          )}

          <TextInput
            label="What is the problem?"
            placeholder="For example: Deep pothole near the bus stop"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            error={errors.title}
            autoComplete="off"
          />

          <TextArea
            label="Describe it"
            placeholder="What did you see? How long has it been like this? Is anyone at risk?"
            value={description}
            maxLength={DESC_MAX}
            onChange={(e) => setDescription(e.target.value)}
            error={errors.description}
            helper={`${description.length} / ${DESC_MAX}`}
          />

          <Select
            label="Category"
            optional
            value={category}
            onChange={(e) => setCategory(e.target.value as CategoryId | '')}
            helper="Not sure? Leave it. We will work it out from your description."
          >
            <option value="">Not sure</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>

          <LocationPicker
            value={location}
            onChange={(p) => {
              setLocation(p);
              setErrors((e) => ({ ...e, location: undefined }));
            }}
            error={errors.location}
          />

          <TextInput
            label="Nearby landmark"
            optional
            placeholder="For example: opposite the temple gate"
            value={landmark}
            maxLength={120}
            onChange={(e) => setLandmark(e.target.value)}
          />

          <PhotoInput files={photos} onChange={setPhotos} error={errors.photos} />

          {submitError && <Notification kind="error" title={submitError} />}

          <div className="flex flex-wrap gap-4 pt-2">
            <Button type="submit" disabled={submitting} className="min-w-48">
              {submitting ? 'Sending…' : 'Submit complaint'}
            </Button>
          </div>
        </div>

        <aside className="lg:sticky lg:top-20 self-start bg-surface-1 p-6 text-[0.875rem]">
          <h2 className="text-[1.25rem] mb-4">What happens next</h2>
          <ol className="flex flex-col gap-3 list-decimal pl-5 text-ink-muted">
            <li>You get a complaint ID to track progress.</li>
            <li>We check for similar reports nearby so the same problem is fixed once.</li>
            <li>The right department is assigned and given a deadline.</li>
            <li>The team sends photo evidence when the work is done.</li>
            <li>We check the evidence before closing. You can dispute it if it is not fixed.</li>
          </ol>
          <p className="mt-6 text-[0.75rem] text-ink-muted">
            In an emergency (fire, injury, live electric wire), call <strong className="text-ink">112</strong> first.
          </p>
        </aside>
      </form>
    </Page>
  );
}
