import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Select, TextArea, TextInput } from '../components/Field';
import { Page } from '../components/Layout';
import { LocationPicker } from '../components/LocationPicker';
import { Notification } from '../components/Notification';
import { MAX_PHOTO_BYTES, MAX_PHOTOS, PhotoInput } from '../components/PhotoInput';
import { CATEGORIES, isValidGeoPoint, type CategoryId, type GeoPoint } from '../lib/domain';

export const TITLE_MAX = 120;
export const DESC_MAX = 2000;

type FormStep = 'details' | 'review';
type Errors = Partial<Record<'title' | 'description' | 'location' | 'photos', string>>;

interface ReportPageProps {
  complaintApi?: ComplaintApi;
}

export function ReportPage({ complaintApi = api }: ReportPageProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<FormStep>('details');
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
  const submitInFlight = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const photoAttachmentsSupported = complaintApi.capabilities.photoAttachments;

  useEffect(() => {
    if (failedAttempts > 0) summaryRef.current?.focus();
  }, [failedAttempts]);

  function validate(): Errors {
    const nextErrors: Errors = {};
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();

    if (trimmedTitle.length < 5) nextErrors.title = 'Give the problem a short title of at least 5 characters.';
    else if (trimmedTitle.length > TITLE_MAX) nextErrors.title = `Keep the title to ${TITLE_MAX} characters or fewer.`;

    if (trimmedDescription.length < 10) nextErrors.description = 'Describe the problem in at least 10 characters.';
    else if (trimmedDescription.length > DESC_MAX) nextErrors.description = `Keep the description to ${DESC_MAX} characters or fewer.`;

    if (!isValidGeoPoint(location)) nextErrors.location = 'Place a valid pin on the map so the team can find the issue.';

    if (photos.length > MAX_PHOTOS) nextErrors.photos = `Attach no more than ${MAX_PHOTOS} images.`;
    else if (photos.some((photo) => !photo.type.startsWith('image/'))) nextErrors.photos = 'Choose image files only.';
    else if (photos.some((photo) => photo.size > MAX_PHOTO_BYTES)) nextErrors.photos = 'Each image must be 10 MB or smaller.';
    else if (!photoAttachmentsSupported && photos.length > 0) {
      nextErrors.photos = 'Photo uploads are not available for the configured backend yet.';
    }
    return nextErrors;
  }

  function updateFieldError(field: keyof Errors) {
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSubmitError(null);
  }

  async function submitComplaint() {
    if (submitInFlight.current) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setStep('details');
      setFailedAttempts((value) => value + 1);
      return;
    }

    submitInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await complaintApi.submitComplaint({
        title: title.trim(),
        description: description.trim(),
        location: location!,
        landmark: landmark.trim() || undefined,
        selectedCategory: category || null,
        photos: photoAttachmentsSupported ? photos : [],
      });
      navigate(`/citizen/complaints/${created.publicId}`, {
        state: { justSubmitted: true, photoUploadFailures: created.photoUploadFailures ?? 0 },
      });
    } catch (error) {
      setSubmitError(getSubmissionErrorMessage(error));
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 'details') {
      const nextErrors = validate();
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        setFailedAttempts((value) => value + 1);
        return;
      }
      setSubmitError(null);
      setStep('review');
      return;
    }
    void submitComplaint();
  }

  const errorMessages = Object.values(errors).filter((message): message is string => Boolean(message));

  return (
    <Page
      title="Report a Civic Issue"
      intro="Tell us what is wrong and where. Clear details and a precise location help the right civic team act."
    >
      <form onSubmit={onSubmit} noValidate aria-busy={submitting} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex max-w-[44rem] flex-col gap-6">
          {errorMessages.length > 0 && step === 'details' && (
            <div ref={summaryRef} tabIndex={-1}>
              <Notification kind="error" title={`Please fix ${errorMessages.length === 1 ? '1 field' : `${errorMessages.length} fields`} below`}>
                <ul className="list-disc pl-5">
                  {errorMessages.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </Notification>
            </div>
          )}

          {submitError && <Notification kind="error" title={submitError} />}

          {step === 'details' ? (
            <>
              <Card>
                <fieldset className="flex flex-col gap-6">
                  <legend className="mb-1 text-[1.25rem]">1. Issue details</legend>
                  <TextInput
                    label="What is the problem?"
                    required
                    helper={`Short summary · ${title.length} / ${TITLE_MAX}`}
                    placeholder="For example: Deep pothole near the bus stop"
                    value={title}
                    maxLength={TITLE_MAX}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      updateFieldError('title');
                    }}
                    error={errors.title}
                    autoComplete="off"
                  />
                  <TextArea
                    label="Describe the issue"
                    required
                    helper={`${description.length} / ${DESC_MAX}`}
                    placeholder="What did you see? How long has it been like this? Is anyone at risk?"
                    value={description}
                    maxLength={DESC_MAX}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      updateFieldError('description');
                    }}
                    error={errors.description}
                  />
                  <Select
                    label="Category"
                    optional
                    value={category}
                    onChange={(event) => setCategory(event.target.value as CategoryId | '')}
                    helper="Not sure? Leave it blank and we will classify it."
                  >
                    <option value="">Not sure</option>
                    {CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </Select>
                  <TextInput
                    label="Nearby landmark"
                    optional
                    placeholder="For example: opposite the temple gate"
                    value={landmark}
                    maxLength={120}
                    onChange={(event) => setLandmark(event.target.value)}
                  />
                </fieldset>
              </Card>

              <Card>
                <fieldset className="flex flex-col gap-4">
                  <legend className="mb-1 text-[1.25rem]">2. Location</legend>
                  <p className="text-[0.875rem] text-ink-muted">
                    Location helps the civic team find the issue. We only ask for your location after you choose “Use my current location”.
                    You can always tap the map instead.
                  </p>
                  <LocationPicker
                    value={location}
                    required
                    onChange={(point) => {
                      setLocation(point);
                      updateFieldError('location');
                    }}
                    error={errors.location}
                  />
                </fieldset>
              </Card>

              <Card>
                <fieldset className="flex flex-col gap-4">
                  <legend className="mb-1 text-[1.25rem]">3. Evidence</legend>
                  <PhotoInput
                    files={photos}
                    onChange={(files) => {
                      setPhotos(files);
                      updateFieldError('photos');
                    }}
                    onError={(message) => setErrors((current) => ({ ...current, photos: message }))}
                    error={errors.photos}
                    disabled={!photoAttachmentsSupported}
                    disabledReason={
                      photoAttachmentsSupported
                        ? undefined
                        : 'Photo uploads are pending the backend media contract. You can still submit the issue and location.'
                    }
                  />
                </fieldset>
              </Card>

              <div className="flex flex-wrap gap-4">
                <Button type="submit" disabled={submitting} className="min-w-48">
                  Review complaint
                </Button>
              </div>
            </>
          ) : (
            <Card>
              <div className="flex flex-col gap-6">
                <div>
                  <p className="text-[0.75rem] tracking-[0.02em] text-ink-muted">Final review</p>
                  <h2 className="mt-1 text-[1.5rem]">Check your report before sending</h2>
                  <p className="mt-2 text-ink-muted">We will send only the details shown here. You can go back and edit them.</p>
                </div>
                <dl className="grid gap-x-4 gap-y-3 text-[0.875rem] sm:grid-cols-[9rem_1fr]">
                  <dt className="text-ink-muted">Title</dt><dd>{title.trim()}</dd>
                  <dt className="text-ink-muted">Description</dt><dd className="whitespace-pre-line">{description.trim()}</dd>
                  <dt className="text-ink-muted">Category</dt><dd>{category ? CATEGORIES.find((item) => item.id === category)?.label : 'Not chosen'}</dd>
                  <dt className="text-ink-muted">Location</dt><dd className="font-mono">{location?.lat.toFixed(5)}, {location?.lng.toFixed(5)}</dd>
                  {landmark.trim() && <><dt className="text-ink-muted">Landmark</dt><dd>{landmark.trim()}</dd></>}
                  <dt className="text-ink-muted">Photos</dt><dd>{photos.length || 'None'}</dd>
                </dl>
                <div className="flex flex-wrap gap-4">
                  <Button type="button" variant="tertiary" onClick={() => setStep('details')} disabled={submitting}>
                    Edit details
                  </Button>
                  <Button type="submit" disabled={submitting} className="min-w-48">
                    {submitting ? 'Sending…' : 'Submit complaint'}
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>

        <aside className="self-start bg-surface-1 p-6 text-[0.875rem] lg:sticky lg:top-20">
          <h2 className="mb-4 text-[1.25rem]">What happens next</h2>
          <ol className="flex list-decimal flex-col gap-3 pl-5 text-ink-muted">
            <li>Your report is saved with a reference number.</li>
            <li>The civic team reviews the details and location.</li>
            <li>AI suggests a category and team; a person confirms when unsure.</li>
            <li>The team fixes it, and the fix is checked before it is marked resolved.</li>
          </ol>
          <p className="mt-6 text-[0.75rem] text-ink-muted">
            In an emergency involving fire, injury, or a live electric wire, call <strong className="text-ink">112</strong> first.
          </p>
        </aside>
      </form>
    </Page>
  );
}

function getSubmissionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
    return 'Your report was not sent. Check your connection and try again.';
  }
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
    return 'The report details were not accepted. Review the form and try again.';
  }
  if (error instanceof ApiError && error.status >= 500) {
    return 'The civic service is temporarily unavailable. Your details are still here; try again shortly.';
  }
  return 'Your report was not sent. Review the details and try again.';
}
