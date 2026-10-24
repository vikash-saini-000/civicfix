

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, ButtonLink } from '../components/Button';
import { TextInput } from '../components/Field';
import { PageMeta } from '../components/PageMeta';

const STEPS = [
  { title: 'Report', text: 'Describe the problem, drop a pin and add a photo. Any language is fine.' },
  { title: 'Sorted and assigned', text: 'Similar reports are grouped, prioritised and sent to the right department with a deadline.' },
  { title: 'Fixed and verified', text: 'The team sends before and after evidence. We check it before the complaint is closed.' },
];

export function HomePage() {
  const navigate = useNavigate();
  const [trackId, setTrackId] = useState('');
  const [trackError, setTrackError] = useState<string>();

  function onTrack(e: FormEvent) {
    e.preventDefault();
    const id = trackId.trim().toUpperCase();
    if (!/^CF-\d{4}-\d{5}$/.test(id)) {
      setTrackError('Enter an ID like CF-2026-00141.');
      return;
    }
    navigate(`/complaints/${id}`);
  }

  return (
    <>
      <PageMeta title="CivicFix" />
      <section className="border-b border-hairline">
        <div className="mx-auto max-w-[66rem] px-4 py-12 md:py-20 grid gap-12 lg:grid-cols-[1fr_22rem] lg:items-end">
          <div className="max-w-[40rem]">
            <p className="text-[0.875rem] text-ink-muted mb-4">Civic complaints for your city</p>
            <h1 className="text-[2.625rem] leading-[1.15] md:text-[3.75rem] md:leading-[1.1]">
              See a problem on your street? Report it and follow it until it's fixed.
            </h1>
            <p className="mt-6 text-[1.125rem] text-ink-muted max-w-[34rem]">
              Potholes, garbage, broken streetlights, water leaks. CivicFix sends your report to the right team and only
              closes it when there is proof the work was done.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <ButtonLink to="/report" className="min-w-56">
                Report a problem
              </ButtonLink>
              <ButtonLink to="/complaints" variant="tertiary">
                View my complaints
              </ButtonLink>
            </div>
          </div>

          <form onSubmit={onTrack} className="bg-surface-1 p-6 flex flex-col gap-4" noValidate>
            <h2 className="text-[1.25rem]">Track a complaint</h2>
            <TextInput
              label="Complaint ID"
              placeholder="CF-2026-00141"
              value={trackId}
              onChange={(e) => {
                setTrackId(e.target.value);
                setTrackError(undefined);
              }}
              error={trackError}
              className="bg-canvas! font-mono"
              autoComplete="off"
            />
            <Button type="submit" variant="secondary">
              Track
            </Button>
          </form>
        </div>
      </section>

      <section className="bg-surface-1">
        <div className="mx-auto max-w-[66rem] px-4 py-12 md:py-16">
          <h2 className="text-[1.75rem] mb-8">How it works</h2>
          <ol className="grid gap-px bg-hairline border border-hairline md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="bg-canvas p-6 min-h-48 flex flex-col gap-3">
                <span className="font-mono text-[0.875rem] text-primary">0{i + 1}</span>
                <h3 className="text-[1.25rem]">{s.title}</h3>
                <p className="text-[0.875rem] text-ink-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
