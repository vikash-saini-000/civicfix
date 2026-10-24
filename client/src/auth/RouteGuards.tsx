import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '../api/authTypes';
import { ButtonLink } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorState, LoadingIndicator } from '../components/Feedback';
import { Page } from '../components/Layout';
import { defaultPathForRole, loginPathForDestination } from './navigation';
import { useAuth } from './AuthContext';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { state, refreshSession } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') return <AuthLoading />;
  if (state.status === 'error') {
    return <SessionError message={state.error ?? undefined} onRetry={() => void refreshSession()} />;
  }
  if (state.status === 'unauthenticated' || !state.user) {
    const destination = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={loginPathForDestination(destination)} replace />;
  }
  return <>{children}</>;
}

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { state } = useAuth();
  if (state.status !== 'authenticated' || !state.user) return null;
  if (!roles.includes(state.user.role)) return <ForbiddenPage />;
  return <>{children}</>;
}

export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  if (state.status === 'loading') return <AuthLoading />;
  if (state.status === 'authenticated' && state.user) {
    return <Navigate to={defaultPathForRole(state.user.role)} replace />;
  }
  return <>{children}</>;
}

export function AuthLoading() {
  return (
    <Page title="Checking your session">
      <Card className="max-w-xl">
        <LoadingIndicator label="Checking your session" />
      </Card>
    </Page>
  );
}

function SessionError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <Page title="We could not verify your session">
      <div className="max-w-xl">
        <ErrorState
          title="Session check failed"
          description={message ?? 'The sign-in service could not be reached.'}
          onRetry={onRetry}
        />
      </div>
    </Page>
  );
}

export function ForbiddenPage() {
  return (
    <Page title="Access not available" intro="Your signed-in account does not have access to this workspace.">
      <Card className="max-w-xl">
        <h2 className="text-[1.25rem]">Permission required</h2>
        <p className="mt-2 text-ink-muted">
          If you believe this is incorrect, contact your department or platform administrator. The backend must enforce
          this permission independently of the frontend.
        </p>
        <ButtonLink to="/" variant="tertiary" className="mt-5">
          Return home
        </ButtonLink>
      </Card>
    </Page>
  );
}
