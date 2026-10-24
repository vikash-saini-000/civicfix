import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { AuthApi, AuthUser, LoginCredentials, RegisterInput } from '../api/authTypes';
import { ApiError } from '../api/errors';
import { AuthContractError, parseAuthSession, parseAuthUser } from './validation';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
}

interface AuthContextValue {
  state: AuthState;
  isSubmitting: boolean;
  actionError: string | null;
  login(credentials: LoginCredentials): Promise<AuthUser>;
  /** Undefined when the configured adapter has no registration. */
  register?: (input: RegisterInput) => Promise<AuthUser>;
  logout(): Promise<void>;
  refreshSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, authApi = api }: { children: ReactNode; authApi?: AuthApi }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null, error: null });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    setState({ status: 'loading', user: null, error: null });
    setActionError(null);
    try {
      const rawUser = await authApi.getCurrentUser();
      if (!rawUser) {
        setState({ status: 'unauthenticated', user: null, error: null });
        return;
      }
      setState({ status: 'authenticated', user: parseAuthUser(rawUser), error: null });
    } catch (error) {
      setState({ status: 'error', user: null, error: getSessionErrorMessage(error) });
    }
  }, [authApi]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      setIsSubmitting(true);
      setActionError(null);
      try {
        const session = parseAuthSession(await authApi.login(credentials));
        setState({ status: 'authenticated', user: session.user, error: null });
        return session.user;
      } catch (error) {
        setState({ status: 'unauthenticated', user: null, error: null });
        const message = getAuthActionErrorMessage(error);
        setActionError(message);
        throw error;
      } finally {
        setIsSubmitting(false);
      }
    },
    [authApi],
  );

  const register = useMemo(() => {
    const create = authApi.register?.bind(authApi);
    if (!create) return undefined;
    return async (input: RegisterInput) => {
      setIsSubmitting(true);
      setActionError(null);
      try {
        const session = parseAuthSession(await create(input));
        setState({ status: 'authenticated', user: session.user, error: null });
        return session.user;
      } catch (error) {
        setActionError(getRegisterErrorMessage(error));
        throw error;
      } finally {
        setIsSubmitting(false);
      }
    };
  }, [authApi]);

  const logout = useCallback(async () => {
    setActionError(null);
    try {
      await authApi.logout();
      setState({ status: 'unauthenticated', user: null, error: null });
    } catch (error) {
      setActionError(getAuthActionErrorMessage(error, 'We could not sign you out. Please try again.'));
      throw error;
    }
  }, [authApi]);

  const value = useMemo(
    () => ({ state, isSubmitting, actionError, login, register, logout, refreshSession }),
    [actionError, isSubmitting, login, logout, refreshSession, register, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}

/** Allows data pages to react to a 401 when they are also rendered in isolation in tests. */
export function useOptionalAuth() {
  return useContext(AuthContext);
}

function getSessionErrorMessage(error: unknown): string {
  if (error instanceof AuthContractError) return 'The sign-in service returned an invalid session.';
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
    return 'We could not verify your session. Check your connection and try again.';
  }
  return 'We could not verify your session. Try again.';
}

function getRegisterErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return 'An account with this email already exists. Try signing in.';
  if (error instanceof ApiError && error.status === 429) return 'Too many sign-up attempts. Please wait and try again.';
  if (error instanceof ApiError && error.status === 400) return 'Check the highlighted details and try again.';
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
    return 'The sign-up service could not be reached. Check your connection and try again.';
  }
  return 'We could not create your account. Please try again.';
}

function getAuthActionErrorMessage(error: unknown, fallback = 'We could not sign you in. Please try again.'): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'The email or password is incorrect.';
  }
  if (error instanceof ApiError && error.status === 429) return 'Too many sign-in attempts. Please wait a few minutes and try again.';
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
    return 'The sign-in service could not be reached. Check your connection and try again.';
  }
  if (error instanceof AuthContractError) return 'The sign-in service returned an unexpected response.';
  return fallback;
}
