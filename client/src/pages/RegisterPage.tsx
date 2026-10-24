import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { defaultPathForRole, safeInternalPath } from '../auth/navigation';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/Feedback';
import { Checkbox, TextInput } from '../components/Field';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { cx } from '../lib/cx';
import {
  EMAIL_MAX,
  NAME_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SIGN_UP_FIELDS,
  normalizeEmail,
  passwordStrength,
  serverFieldErrors,
  validateSignUp,
  type SignUpErrors,
  type SignUpField,
} from '../lib/signup';

const FIELD_LABELS: Record<SignUpField, string> = {
  name: 'Full name',
  email: 'Email address',
  password: 'Password',
  confirmPassword: 'Confirm password',
  consent: 'Privacy notice',
};

/** Citizen sign-up: POST /api/v1/auth/register creates a CITIZEN account and signs in (docs/api/AUTHENTICATION.md). */
export function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isSubmitting, register } = useAuth();
  const params = new URLSearchParams(location.search);
  const next = safeInternalPath(params.get('next'));

  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => params.get('email')?.slice(0, EMAIL_MAX) ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [errors, setErrors] = useState<SignUpErrors>({});
  const [touched, setTouched] = useState<Partial<Record<SignUpField, boolean>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submitInFlight = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirmPassword: useRef<HTMLInputElement>(null),
    consent: useRef<HTMLInputElement>(null),
  };

  const strength = useMemo(() => passwordStrength(password, { email, name }), [email, name, password]);

  // After a failed submit, move focus to the summary so screen-reader users hear what to fix.
  useEffect(() => {
    if (attempt > 0) summaryRef.current?.focus();
  }, [attempt]);

  if (!register) {
    return (
      <Page title="Create an account" intro="Registration needs the CivicFix backend.">
        <Card className="max-w-xl">
          <EmptyState
            title="Registration is not available in demo mode"
            description="Run the app with VITE_CIVICFIX_API_MODE=http and the backend server to create an account."
            action={<ButtonLink to="/login" variant="tertiary">Return to log in</ButtonLink>}
          />
        </Card>
      </Page>
    );
  }

  const values = { name, email, password, confirmPassword, consent };
  const loginHref = `/login?${new URLSearchParams({ ...(next ? { next } : {}), ...(email.trim() ? { email: normalizeEmail(email) } : {}) })}`;

  /** Validate one field when the person leaves it, so errors don't appear while they are still typing. */
  function blur(field: SignUpField) {
    setTouched((current) => ({ ...current, [field]: true }));
    const all = validateSignUp(values);
    setErrors((current) => ({ ...current, [field]: field === 'consent' ? current.consent : all[field] }));
  }

  function change(field: SignUpField, apply: () => void) {
    apply();
    setFormError(null);
    if (field === 'email') setEmailTaken(false);
    // Clear a shown error as soon as the person starts fixing it.
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState?.('CapsLock') ?? false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitInFlight.current || !register) return;
    const found = validateSignUp(values);
    setErrors(found);
    setTouched({ name: true, email: true, password: true, confirmPassword: true, consent: true });
    setFormError(null);
    if (Object.keys(found).length > 0) {
      setAttempt((value) => value + 1);
      return;
    }

    submitInFlight.current = true;
    try {
      // Only the three fields the backend accepts. Consent is recorded by the act of signing up.
      const user = await register({ name: name.trim(), email: normalizeEmail(email), password });
      const destination = next && next.startsWith('/citizen') ? next : defaultPathForRole(user.role);
      navigate(destination, { replace: true, state: { welcome: true } });
    } catch (error) {
      handleServerError(error);
      setAttempt((value) => value + 1);
    } finally {
      submitInFlight.current = false;
    }
  }

  function handleServerError(error: unknown) {
    if (error instanceof ApiError && error.status === 409) {
      setEmailTaken(true);
      setErrors({ email: 'An account with this email already exists.' });
      return;
    }
    if (error instanceof ApiError && error.status === 400) {
      const fields = serverFieldErrors(error.details);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
        return;
      }
    }
    if (error instanceof ApiError && error.status === 429) {
      setFormError('Too many accounts were created from this network recently. Please wait a while and try again.');
      return;
    }
    if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
      setFormError('We could not reach CivicFix. Check your connection and try again; your details are still here.');
      return;
    }
    setFormError('We could not create your account just now. Please try again in a moment.');
  }

  const summary = SIGN_UP_FIELDS.filter((field) => errors[field]).map((field) => ({ field, message: errors[field]! }));
  const showStrength = password.length > 0;
  const confirmMatches = confirmPassword.length > 0 && confirmPassword === password;

  return (
    <Page title="Create your account" intro="Report problems in your area and follow each one until it is fixed and checked.">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,34rem)_minmax(18rem,1fr)] lg:items-start">
        <Card className="p-6 md:p-8">
          <form onSubmit={onSubmit} noValidate aria-describedby="signup-required-note" className="flex flex-col gap-6">
            <p id="signup-required-note" className="text-[0.75rem] text-ink-muted">All fields are required. It takes under a minute.</p>

            {(summary.length > 0 || formError) && (
              <div ref={summaryRef} tabIndex={-1} className="outline-none">
                {formError && summary.length === 0 ? (
                  <Notification kind="error" title={formError} />
                ) : (
                  <Notification kind="error" title={summary.length === 1 ? 'Fix 1 thing to continue' : `Fix ${summary.length} things to continue`}>
                    <ul className="list-disc pl-5">
                      {summary.map(({ field, message }) => (
                        <li key={field}>
                          <button
                            type="button"
                            className="text-left text-error underline underline-offset-2"
                            onClick={() => refs[field].current?.focus()}
                          >
                            {FIELD_LABELS[field]}: {message}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Notification>
                )}
              </div>
            )}

            <TextInput
              ref={refs.name}
              label={FIELD_LABELS.name}
              name="name"
              autoComplete="name"
              autoCapitalize="words"
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => change('name', () => setName(e.target.value))}
              onBlur={() => blur('name')}
              error={touched.name ? errors.name : undefined}
              helper="Department staff see a pseudonym, not your name."
              disabled={isSubmitting}
            />

            <div className="flex flex-col gap-2">
              <TextInput
                ref={refs.email}
                label={FIELD_LABELS.email}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                maxLength={EMAIL_MAX}
                value={email}
                onChange={(e) => change('email', () => setEmail(e.target.value))}
                onBlur={() => blur('email')}
                error={touched.email ? errors.email : undefined}
                helper="You sign in with this. It is never shown to department staff."
                disabled={isSubmitting}
              />
              {emailTaken && (
                <p className="text-[0.875rem]">
                  Is it yours? <Link to={loginHref}>Log in instead</Link>.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <div className="relative">
                <TextInput
                  ref={refs.password}
                  label={FIELD_LABELS.password}
                  name="new-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  maxLength={PASSWORD_MAX}
                  value={password}
                  onChange={(e) => change('password', () => setPassword(e.target.value))}
                  onBlur={() => blur('password')}
                  onKeyUp={trackCapsLock}
                  onKeyDown={trackCapsLock}
                  error={touched.password ? errors.password : undefined}
                  helper={`At least ${PASSWORD_MIN} characters. A short phrase of a few words is easy to remember and hard to guess.`}
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  className="absolute right-0 top-0 min-h-8 px-1 text-[0.75rem] text-primary underline underline-offset-2"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? 'Hide password' : 'Show password'}
                </button>
              </div>
              {capsLock && <p className="text-[0.75rem] text-ink" role="status">Caps Lock is on.</p>}
              {showStrength && <StrengthMeter level={strength.level} label={strength.label} hint={strength.hint} />}
            </div>

            <div className="flex flex-col gap-2">
              <TextInput
                ref={refs.confirmPassword}
                label={FIELD_LABELS.confirmPassword}
                name="confirm-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                maxLength={PASSWORD_MAX}
                value={confirmPassword}
                onChange={(e) => change('confirmPassword', () => setConfirmPassword(e.target.value))}
                onBlur={() => blur('confirmPassword')}
                onKeyUp={trackCapsLock}
                error={touched.confirmPassword ? errors.confirmPassword : undefined}
                disabled={isSubmitting}
              />
              {confirmMatches && !errors.confirmPassword && (
                <p className="flex items-center gap-2 text-[0.75rem] text-tag-green-fg">
                  <CheckIcon /> Passwords match.
                </p>
              )}
            </div>

            <div className="border-t border-hairline pt-6">
              <PrivacyNotice />
              <Checkbox
                ref={refs.consent}
                label="I have read the privacy notice and agree to CivicFix storing my details to handle my reports."
                checked={consent}
                onChange={(e) => change('consent', () => setConsent(e.target.checked))}
                error={touched.consent ? errors.consent : undefined}
                disabled={isSubmitting}
              />
            </div>

            <Button type="submit" disabled={isSubmitting} className="w-full" aria-live="polite">
              {isSubmitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                  Creating your account…
                </>
              ) : (
                'Create account'
              )}
            </Button>

            <p className="text-center text-[0.875rem] text-ink-muted">
              Already have an account? <Link to={loginHref}>Log in</Link>
            </p>
          </form>
        </Card>

        <WhatYouGet />
      </div>
    </Page>
  );
}

function StrengthMeter({ level, label, hint }: { level: number; label: string; hint: string }) {
  const colors = ['bg-surface-2', 'bg-error', 'bg-caution', 'bg-primary', 'bg-success'];
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="grid grid-cols-4 gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <span key={segment} className={cx('h-1 transition-colors duration-200', segment <= level ? colors[level] : 'bg-surface-2')} />
        ))}
      </div>
      <p className="text-[0.75rem] text-ink-muted">
        <span className="font-semibold text-ink">Strength: {label}.</span> {hint}
      </p>
    </div>
  );
}

function PrivacyNotice() {
  return (
    <details className="group mb-4 bg-surface-1 px-4 py-3 text-[0.875rem]">
      <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between font-semibold marker:hidden">
        Privacy notice: what we keep and who sees it
        <span aria-hidden="true" className="text-ink-muted transition-transform duration-200 group-open:rotate-180">▾</span>
      </summary>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-ink-muted">
        <li>We store your name, email address and the reports you send (text, location and photos).</li>
        <li>Department staff see a pseudonym such as “Reporter #a1b2c3”, never your email. Platform administrators can see your name.</li>
        <li>Staff see a privacy copy of your photos: hidden metadata such as GPS is removed, and faces and number plates are blurred when detection is available.</li>
        <li>Your password is stored only as a secure hash. CivicFix never asks for it by email or phone.</li>
        <li>CivicFix is a demo civic service; do not use it for emergencies. Call 112.</li>
      </ul>
    </details>
  );
}

function WhatYouGet() {
  return (
    <aside className="flex flex-col gap-8 bg-inverse p-6 text-white md:p-8" aria-labelledby="benefits-heading">
      <div>
        <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-[#c6c6c6]">Citizen account</p>
        <h2 id="benefits-heading" className="mt-3 text-[1.75rem] leading-tight text-white">From report to verified fix</h2>
      </div>
      <ol className="flex flex-col gap-6">
        <Benefit number="01" title="Report in a minute">Describe the problem, drop a pin and add a photo. You get a reference number straight away.</Benefit>
        <Benefit number="02" title="Follow every step">See when it is reviewed, assigned and worked on. Updates arrive in your notifications.</Benefit>
        <Benefit number="03" title="Only closed when it is fixed">The team must send evidence, a manager checks it, and you can confirm or dispute the fix.</Benefit>
      </ol>
      <p className="border-t border-[#393939] pt-6 text-[0.8125rem] text-[#c6c6c6]">
        Staff accounts are created by your city administrator. This form creates a citizen account only.
      </p>
    </aside>
  );
}

function Benefit({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_1fr] gap-3">
      <span className="font-mono text-[0.875rem] text-[#78a9ff]">{number}</span>
      <div>
        <h3 className="text-[1rem] font-semibold text-white">{title}</h3>
        <p className="mt-1 text-[0.875rem] text-[#c6c6c6]">{children}</p>
      </div>
    </li>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

