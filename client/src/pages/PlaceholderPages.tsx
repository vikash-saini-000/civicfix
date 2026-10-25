import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { API_MODE, AUTH_MODE } from '../api';
import type { Role } from '../api/authTypes';
import { MOCK_AUTH_MODE_LABEL } from '../api/mockAuthApi';
import { Button, ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/Feedback';
import { TextInput } from '../components/Field';
import { Page } from '../components/Layout';
import { Notification } from '../components/Notification';
import { CAPTCHA_ENABLED, Turnstile, type TurnstileHandle } from '../components/Turnstile';
import { useAuth } from '../auth/AuthContext';
import { defaultPathForRole, ROLE_LABELS, safeInternalPath } from '../auth/navigation';

type LoginErrors = Partial<Record<'email' | 'password', string>>;

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, isSubmitting, actionError, login } = useAuth();
  const [email, setEmail] = useState(() => new URLSearchParams(location.search).get('email')?.slice(0, 254) ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [failedAttempts, setFailedAttempts] = useState(0);
  const submitInFlight = useRef(false);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  useEffect(() => {
    if (failedAttempts > 0) errorSummaryRef.current?.focus();
  }, [failedAttempts]);

  function validate(): LoginErrors {
    const nextErrors: LoginErrors = {};
    if (!email.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) nextErrors.email = 'Enter a valid email address.';
    if (!password) nextErrors.password = 'Enter your password.';
    return nextErrors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitInFlight.current) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFailedAttempts((value) => value + 1);
      return;
    }

    submitInFlight.current = true;
    try {
      const user = await login({ email, password, captchaToken: captchaToken ?? undefined });
      const requestedDestination = new URLSearchParams(location.search).get('next');
      navigate(safeInternalPath(requestedDestination) ?? defaultPathForRole(user.role), { replace: true });
    } catch {
      // AuthContext exposes a safe, user-facing message. Credentials are never logged or echoed.
      turnstile.current?.reset(); // tokens are single-use
    } finally {
      submitInFlight.current = false;
    }
  }

  const validationMessages = Object.values(errors).filter((message): message is string => Boolean(message));

  return (
    <Page title="Log in" intro="Sign in to report civic problems and follow updates from the right team.">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,32rem)_minmax(16rem,20rem)] lg:items-start">
        <Card>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
            {validationMessages.length > 0 && (
              <div ref={errorSummaryRef} tabIndex={-1}>
                <Notification kind="error" title="Check the highlighted fields">
                  <ul className="list-disc pl-5">
                    {validationMessages.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                </Notification>
              </div>
            )}

            {state.error && !actionError && <Notification kind="warning" title={state.error} />}
            {actionError && <Notification kind="error" title={actionError} />}

            <TextInput
              label="Email address"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setErrors((current) => ({ ...current, email: undefined }));
              }}
              error={errors.email}
              disabled={isSubmitting}
            />

            <div className="relative">
              <TextInput
                label="Password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setErrors((current) => ({ ...current, password: undefined }));
                }}
                error={errors.password}
                disabled={isSubmitting}
              />
              <button
                type="button"
                className="absolute right-0 top-0 min-h-8 text-[0.75rem] text-primary underline underline-offset-2"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? 'Hide password' : 'Show password'}
              </button>
            </div>

            <Turnstile ref={turnstile} action="login" onToken={setCaptchaToken} />

            <Button type="submit" disabled={isSubmitting || (CAPTCHA_ENABLED && !captchaToken)}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
            {API_MODE === 'http' && (
              <p className="text-[0.875rem] text-ink-muted">
                New to CivicFix?{' '}
                <Link to={`/register${new URLSearchParams(location.search).get('next') ? `?next=${encodeURIComponent(new URLSearchParams(location.search).get('next')!)}` : ''}`}>
                  Create a citizen account
                </Link>
                .
              </p>
            )}
          </form>
        </Card>

        {AUTH_MODE === 'mock' && API_MODE === 'mock' && (
          <Notification kind="info" title={MOCK_AUTH_MODE_LABEL}>
            <p>For local UI development only. Use any of these demo accounts with password <code>demo-password</code>:</p>
            <ul className="mt-2 list-disc pl-5">
              <li><code>citizen@example.test</code> — Citizen</li>
              <li><code>member@example.test</code> — Department member</li>
              <li><code>manager@example.test</code> — Department manager</li>
              <li><code>admin@example.test</code> — Platform administrator</li>
            </ul>
          </Notification>
        )}
      </div>
    </Page>
  );
}

export function RolePlaceholderPage({ role }: { role: string }) {
  return (
    <Page
      title={`${role} workspace`}
      intro="Page not found in this workspace."
    >
      <Card className="max-w-2xl">
        <EmptyState
          title="Page not found"
          description={`This ${ROLE_LABELS[roleToKey(role)] ?? role} page does not exist. Use the navigation above to reach your workspace.`}
          action={<ButtonLink to="/">Return to the public home page</ButtonLink>}
        />
      </Card>
    </Page>
  );
}

function roleToKey(role: string): Role {
  if (role === 'Citizen') return 'citizen';
  if (role === 'Department member') return 'department_member';
  if (role === 'Department manager') return 'department_manager';
  return 'platform_admin';
}
