

import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, ButtonLink } from '../components/Button';
import { TextInput } from '../components/Field';
import { PageMeta } from '../components/PageMeta';
import { isUsableComplaintId } from '../lib/complaints';

const STEPS = [
  {
    number: '01',
    title: 'Tell us what happened',
    text: 'Describe the problem in plain language, add the location and attach a photo if it helps.',
    icon: 'report',
  },
  {
    number: '02',
    title: 'Follow the progress',
    text: 'Your complaint gets an ID so you can find it again and see the latest public status updates.',
    icon: 'track',
  },
  {
    number: '03',
    title: 'See what happens next',
    text: 'When the connected city workflow provides an update, it appears on your complaint timeline.',
    icon: 'check',
  },
];

const REPORTABLE_PROBLEMS = [
  { label: 'Roads and sidewalks', detail: 'Potholes, damaged paving and blocked paths.', icon: 'road' },
  { label: 'Street lighting', detail: 'Lights that are broken, unsafe or not working.', icon: 'light' },
  { label: 'Waste and cleanliness', detail: 'Overflowing bins, missed collection and litter.', icon: 'waste' },
  { label: 'Water and drainage', detail: 'Leaks, flooding and blocked drains.', icon: 'water' },
];

const FAQS = [
  {
    question: 'What can I report?',
    answer: 'Use CivicFix for visible public problems such as potholes, broken streetlights, overflowing bins, leaks and blocked drains. For an emergency or an immediate threat to life, contact your local emergency service first.',
  },
  {
    question: 'Do I need a photo?',
    answer: 'No. A clear description and location are enough to start. A photo can help the right team understand the problem faster when it is safe for you to take one.',
  },
  {
    question: 'How do I find my complaint again?',
    answer: 'After you submit, use the complaint ID shown by CivicFix. You can enter it in the tracker on this page to open the complaint timeline.',
  },
  {
    question: 'Will CivicFix fix the problem immediately?',
    answer: 'CivicFix helps you send and follow a report. Response times and available actions depend on the connected city department and its workflow.',
  },
];

export function HomePage() {
  const navigate = useNavigate();
  const [trackId, setTrackId] = useState('');
  const [trackError, setTrackError] = useState<string>();

  function onTrack(e: FormEvent) {
    e.preventDefault();
    const id = trackId.trim().toUpperCase();
    if (!isUsableComplaintId(id)) {
      setTrackError('Enter a valid complaint ID.');
      return;
    }
    navigate(`/citizen/complaints/${encodeURIComponent(id)}`);
  }

  return (
    <>
      <PageMeta
        title="CivicFix"
        description="Report public problems, follow complaint updates and help your city understand what needs attention."
      />

      <section className="border-b border-hairline bg-canvas" aria-labelledby="hero-heading">
        <div className="mx-auto grid max-w-[66rem] gap-10 px-4 py-12 md:py-20 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center lg:gap-16">
          <div className="max-w-[42rem]">
            <div className="mb-6 inline-flex items-center gap-2 border border-hairline bg-surface-1 px-3 py-2 text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-ink-muted">
              <span className="h-2 w-2 bg-success" aria-hidden="true" />
              A clearer way to speak up about your city
            </div>
            <h1 id="hero-heading" className="max-w-[40rem] text-[2.75rem] leading-[1.1] md:text-[4.25rem] md:leading-[1.05]">
              See a problem? Help get it on the right team&apos;s radar.
            </h1>
            <p className="mt-6 max-w-[38rem] text-[1.125rem] leading-8 text-ink-muted">
              CivicFix gives residents one simple place to report public problems, share the important details and follow
              what happens next.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/citizen/complaints/new" className="min-w-52">
                Report a problem
              </ButtonLink>
              <a
                href="#how-it-works"
                className="inline-flex min-h-12 items-center justify-center border border-primary px-4 text-[0.875rem] font-normal text-primary no-underline transition-colors duration-200 hover:bg-primary hover:text-on-primary"
              >
                See how it works
              </a>
            </div>
            <p className="mt-5 text-[0.875rem] text-ink-muted">
              New here? <Link to="/register">Create a free citizen account</Link> to report and follow your complaints.
            </p>
            <p className="mt-3 max-w-[34rem] text-[0.8125rem] text-ink-muted">
              Not sure where to start? Include what you saw, where you saw it and when it happened. That is enough to
              begin.
            </p>
          </div>

          <div className="relative">
            <div className="absolute -inset-3 border border-primary/20" aria-hidden="true" />
            <form id="track" onSubmit={onTrack} className="relative flex flex-col gap-5 bg-inverse p-6 text-white md:p-7" noValidate>
              <div>
                <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-[#c6c6c6]">Already reported?</p>
                <h2 className="mt-2 text-[1.5rem] text-white">Track your complaint</h2>
                <p className="mt-2 text-[0.875rem] leading-6 text-[#c6c6c6]">
                  Enter the complaint ID you received after submitting a report.
                </p>
              </div>
              <TextInput
                label="Complaint ID"
                placeholder="CF-2026-00141"
                value={trackId}
                onChange={(e) => {
                  setTrackId(e.target.value);
                  setTrackError(undefined);
                }}
                error={trackError}
                className="bg-canvas! font-mono text-ink"
                autoComplete="off"
              />
              <Button type="submit" variant="primary" className="bg-white! text-inverse! hover:bg-[#e0e0e0]!">
                Track complaint
              </Button>
              <p className="text-[0.75rem] text-[#c6c6c6]">Your ID is private to your account. Do not share it publicly.</p>
            </form>
          </div>
        </div>
      </section>

      <section className="border-b border-hairline bg-surface-1" aria-labelledby="reportable-heading">
        <div className="mx-auto max-w-[66rem] px-4 py-12 md:py-16">
          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:items-start">
            <div className="max-w-[24rem]">
              <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-primary">Start with what you see</p>
              <h2 id="reportable-heading" className="mt-3 text-[2rem] leading-tight md:text-[2.5rem]">
                Everyday problems deserve a clear path forward.
              </h2>
              <p className="mt-4 text-ink-muted">
                CivicFix is for non-emergency issues in shared public spaces. Choose the closest description when you
                report and add the details that will help someone find the problem.
              </p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="Examples of problems you can report">
              {REPORTABLE_PROBLEMS.map((problem) => (
                <li key={problem.label} className="flex gap-4 border border-hairline bg-canvas p-5">
                  <Icon kind={problem.icon} className="mt-1 shrink-0 text-primary" />
                  <div>
                    <h3 className="text-[1.125rem]">{problem.label}</h3>
                    <p className="mt-2 text-[0.875rem] leading-6 text-ink-muted">{problem.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 border-b border-hairline" aria-labelledby="how-it-works-heading">
        <div className="mx-auto max-w-[66rem] px-4 py-12 md:py-16">
          <div className="mb-8 max-w-[38rem]">
            <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-primary">Simple by design</p>
            <h2 id="how-it-works-heading" className="mt-3 text-[2rem] leading-tight md:text-[2.5rem]">
              From first report to latest update, keep the context together.
            </h2>
          </div>
          <ol className="grid gap-px border border-hairline bg-hairline md:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.title} className="flex min-h-60 flex-col gap-4 bg-canvas p-6 md:p-7">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[0.8125rem] text-primary">{step.number}</span>
                  <Icon kind={step.icon} className="text-primary" />
                </div>
                <h3 className="text-[1.375rem]">{step.title}</h3>
                <p className="text-[0.9375rem] leading-7 text-ink-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-b border-hairline bg-[#edf5ff]" aria-labelledby="confidence-heading">
        <div className="mx-auto grid max-w-[66rem] gap-10 px-4 py-12 md:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-primary">What you can expect</p>
            <h2 id="confidence-heading" className="mt-3 text-[2rem] leading-tight md:text-[2.5rem]">
              Clear information, without needing to know the department first.
            </h2>
            <p className="mt-4 max-w-[34rem] text-ink-muted">
              Give CivicFix the details you have. The connected workflow can use the location, category and description
              to help route the report. You can return to the same complaint to read its public timeline.
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="CivicFix benefits">
            <Benefit icon="pin" title="Location matters" text="Add a landmark or map location so the problem can be found." />
            <Benefit icon="eye" title="Progress is visible" text="See public status updates in one complaint timeline." />
            <Benefit icon="note" title="Your words help" text="A specific description gives the receiving team useful context." />
            <Benefit icon="shield" title="No emergency promises" text="For immediate danger, use your local emergency service first." />
          </ul>
        </div>
      </section>

      <section className="border-b border-hairline" aria-labelledby="faq-heading">
        <div className="mx-auto max-w-[66rem] px-4 py-12 md:py-16">
          <div className="mb-8 max-w-[38rem]">
            <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-primary">Before you report</p>
            <h2 id="faq-heading" className="mt-3 text-[2rem] leading-tight md:text-[2.5rem]">
              Questions citizens often have.
            </h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {FAQS.map((faq) => (
              <details key={faq.question} className="group border border-hairline bg-canvas p-5">
                <summary className="cursor-pointer list-none pr-8 text-[1.0625rem] font-semibold marker:hidden">
                  <span className="relative block after:absolute after:right-0 after:top-1/2 after:-translate-y-1/2 after:text-[1.25rem] after:font-normal after:content-['+'] group-open:after:content-['−']">
                    {faq.question}
                  </span>
                </summary>
                <p className="mt-4 max-w-[34rem] text-[0.9375rem] leading-7 text-ink-muted">{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-inverse text-white" aria-labelledby="cta-heading">
        <div className="mx-auto flex max-w-[66rem] flex-col gap-6 px-4 py-12 md:flex-row md:items-center md:justify-between md:py-16">
          <div className="max-w-[38rem]">
            <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-[#c6c6c6]">Your next step</p>
            <h2 id="cta-heading" className="mt-3 text-[2rem] leading-tight text-white md:text-[2.5rem]">
              Notice something that needs attention?
            </h2>
            <p className="mt-4 text-[#c6c6c6]">
              Share the details you know. A better report starts with a clear picture of the problem.
            </p>
          </div>
          <ButtonLink to="/citizen/complaints/new" className="shrink-0 bg-white! text-inverse! hover:bg-[#e0e0e0]!">
            Report a problem
          </ButtonLink>
        </div>
      </section>
    </>
  );
}

function Benefit({ icon, title, text }: { icon: IconKind; title: string; text: string }) {
  return (
    <li className="border border-[#b8d3ff] bg-canvas p-5">
      <Icon kind={icon} className="text-primary" />
      <h3 className="mt-4 text-[1.0625rem]">{title}</h3>
      <p className="mt-2 text-[0.875rem] leading-6 text-ink-muted">{text}</p>
    </li>
  );
}

type IconKind = 'check' | 'eye' | 'light' | 'note' | 'pin' | 'report' | 'road' | 'shield' | 'track' | 'water' | 'waste';

function Icon({ kind, className = '' }: { kind: string; className?: string }) {
  const common = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const;
  const paths: Record<string, ReactNode> = {
    check: <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" />,
    eye: <><path d="M2.5 12s3.2-5 9.5-5 9.5 5 9.5 5-3.2 5-9.5 5-9.5-5-9.5-5Z" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.6" /></>,
    light: <><path d="M9 18h6M10 21h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" /><path d="M8.2 14.5A6 6 0 1 1 15.8 14.5c-.8.7-1.2 1.4-1.3 2.5h-5c-.1-1.1-.5-1.8-1.3-2.5Z" stroke="currentColor" strokeWidth="1.6" /></>,
    note: <><path d="M6 3.5h9l3 3V20.5H6V3.5Z" stroke="currentColor" strokeWidth="1.6" /><path d="M14.5 3.8v3h3M8.5 11h7M8.5 14.5h7" stroke="currentColor" strokeWidth="1.6" /></>,
    pin: <><path d="M19 10.2c0 5.1-7 10.3-7 10.3S5 15.3 5 10.2a7 7 0 1 1 14 0Z" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.6" /></>,
    report: <><path d="M5 4h14v16H5V4Z" stroke="currentColor" strokeWidth="1.6" /><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.6" /></>,
    road: <><path d="M7 21 10 3M17 21 14 3" stroke="currentColor" strokeWidth="1.6" /><path d="M12 5v3M12 11v3M12 17v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" /></>,
    shield: <path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" />,
    track: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" /></>,
    water: <><path d="M12 3s5 5.2 5 9.3a5 5 0 1 1-10 0C7 8.2 12 3 12 3Z" stroke="currentColor" strokeWidth="1.6" /><path d="M9.5 13.5c.5 1.4 1.3 2.1 2.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
    waste: <><path d="M7 7h10l-.7 13H7.7L7 7ZM5 7h14M9 4h6l1 3H8l1-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" /><path d="M10 10v7M14 10v7" stroke="currentColor" strokeWidth="1.6" /></>,
  };

  return <svg {...common} className={className}>{paths[kind]}</svg>;
}
