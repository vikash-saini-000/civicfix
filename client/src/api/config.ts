import { ApiConfigError } from './errors';

export type ApiMode = 'mock' | 'http';
export type AuthMode = ApiMode;

export interface ApiConfig {
  mode: ApiMode;
  baseUrl: string;
  timeoutMs: number;
}

export interface ApiEnvironment {
  mode?: string;
  baseUrl?: string;
  timeoutMs?: string;
}

export interface AuthConfig {
  mode: AuthMode;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function resolveApiConfig(environment: ApiEnvironment, _isDevelopment: boolean): ApiConfig {
  const configuredMode = environment.mode?.trim().toLowerCase();
  // The real backend is the default everywhere; mock data is opt-in for UI work without a server.
  const mode = configuredMode || 'http';
  if (mode !== 'mock' && mode !== 'http') {
    throw new ApiConfigError('VITE_CIVICFIX_API_MODE must be either "mock" or "http".');
  }

  const timeoutMs = environment.timeoutMs ? Number(environment.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ApiConfigError('VITE_CIVICFIX_API_TIMEOUT_MS must be a positive number.');
  }

  return {
    mode,
    baseUrl: environment.baseUrl?.trim().replace(/\/$/, '') ?? '',
    timeoutMs,
  };
}

export function getApiConfig(): ApiConfig {
  return resolveApiConfig(
    {
      mode: import.meta.env.VITE_CIVICFIX_API_MODE,
      baseUrl: import.meta.env.VITE_CIVICFIX_API_BASE_URL,
      timeoutMs: import.meta.env.VITE_CIVICFIX_API_TIMEOUT_MS,
    },
    import.meta.env.DEV,
  );
}

export function resolveAuthConfig(
  environment: Pick<ApiEnvironment, 'mode'>,
  isDevelopment: boolean,
  apiMode: ApiMode,
): AuthConfig {
  const configuredMode = environment.mode?.trim().toLowerCase();
  const mode = configuredMode || apiMode;
  if (mode !== 'mock' && mode !== 'http') {
    throw new ApiConfigError('VITE_CIVICFIX_AUTH_MODE must be either "mock" or "http".');
  }
  if (!isDevelopment && mode === 'mock') {
    throw new ApiConfigError('Mock authentication cannot be enabled in a production build.');
  }
  if (mode !== apiMode) {
    throw new ApiConfigError('API and authentication modes must match to prevent mixed data sources.');
  }
  return { mode };
}

export function getAuthConfig(apiConfig: ApiConfig): AuthConfig {
  return resolveAuthConfig(
    { mode: import.meta.env.VITE_CIVICFIX_AUTH_MODE },
    import.meta.env.DEV,
    apiConfig.mode,
  );
}
