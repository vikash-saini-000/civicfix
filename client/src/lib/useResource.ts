import { useCallback, useEffect, useState } from 'react';
import { ApiError, getUserFacingApiMessage } from '../api/errors';
import { useOptionalAuth } from '../auth/AuthContext';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  /** HTTP status of the last failure (0 for network errors). */
  errorStatus: number | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data with cancellation. A 401 that survives the adapter's own token refresh means the
 * session ended, so the auth context re-checks and sends the user to sign in.
 */
export function useResource<T>(load: ((signal: AbortSignal) => Promise<T>) | null, deps: readonly unknown[]): Resource<T> {
  const refreshSession = useOptionalAuth()?.refreshSession;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(Boolean(load));
  const [token, setToken] = useState(0);
  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    if (!load) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    load(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) void refreshSession?.();
        setError(getUserFacingApiMessage(err));
        setErrorStatus(err instanceof ApiError ? err.status : null);
        setLoading(false);
      });
    return () => controller.abort();
  }, [...deps, token]);

  return { data, error, errorStatus, loading, reload };
}

/** Runs one user action at a time and keeps its error message. */
export function useAction() {
  const refreshSession = useOptionalAuth()?.refreshSession;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await action();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) void refreshSession?.();
        setError(actionErrorMessage(err));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refreshSession],
  );

  return { busy, error, setError, run };
}

export function actionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return `${error.message} Refresh to see the latest state.`;
    if (error.status === 400 && Array.isArray(error.details) && error.details.length > 0) {
      const first = error.details[0] as { message?: unknown };
      if (typeof first?.message === 'string') return `${error.message} ${first.message}`;
    }
  }
  return getUserFacingApiMessage(error, 'That action could not be completed. Please try again.');
}
