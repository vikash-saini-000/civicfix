import type { Complaint, NewComplaintInput } from '../lib/domain';
import type { AuthSession, AuthUser, LoginCredentials } from './authTypes';
import { parseComplaint, parseComplaintList } from './complaintContract';
import { ApiError } from './errors';
import type { CivicFixApi } from './types';

export interface HttpApiOptions {
  baseUrl: string;
  timeoutMs: number;
  getAccessToken?: () => string | null;
  credentials?: RequestCredentials;
}

export class HttpCivicFixApi implements CivicFixApi {
  constructor(private readonly options: HttpApiOptions) {}

  readonly capabilities = { photoAttachments: false } as const;

  login(credentials: LoginCredentials, signal?: AbortSignal): Promise<AuthSession> {
    return this.request<AuthSession>('/api/v1/auth/login', { method: 'POST', body: credentials, signal });
  }

  getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null> {
    return this.request<AuthUser>('/api/v1/auth/me', { signal }).catch((error: unknown) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
      throw error;
    });
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.request<void>('/api/v1/auth/logout', { method: 'POST', signal });
  }

  listMyComplaints(signal?: AbortSignal): Promise<Complaint[]> {
    return this.request<unknown>('/api/v1/complaints', { signal }).then(parseComplaintList);
  }

  getComplaint(publicId: string, signal?: AbortSignal): Promise<Complaint | null> {
    return this.request<unknown>(`/api/v1/complaints/${encodeURIComponent(publicId)}`, { signal })
      .then(parseComplaint)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
  }

  submitComplaint(input: NewComplaintInput, signal?: AbortSignal): Promise<Complaint> {
    if (input.photos.length > 0) {
      return Promise.reject(new ApiError('Photo uploads are not configured for the backend contract yet.', 501, 'MEDIA_NOT_CONFIGURED'));
    }
    const body = {
      title: input.title,
      description: input.description,
      location: input.location,
      selectedCategory: input.selectedCategory,
      landmark: input.landmark,
    };
    return this.request<unknown>('/api/v1/complaints', { method: 'POST', body, signal }).then(parseComplaint);
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: BodyInit | object; signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), this.options.timeoutMs);
    const signal = mergeSignals(options.signal, controller.signal);
    const token = this.options.getAccessToken?.();
    const headers = new Headers({ Accept: 'application/json' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const body = options.body instanceof FormData || typeof options.body === 'string' || options.body === undefined
      ? options.body
      : JSON.stringify(options.body);

    try {
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal,
        credentials: this.options.credentials ?? 'include',
      });
      const payload = await readResponse(response);
      if (!response.ok) {
        const errorPayload = isRecord(payload) ? payload : {};
        throw new ApiError(
          typeof errorPayload.message === 'string' ? errorPayload.message : 'The request was not accepted.',
          response.status,
          typeof errorPayload.code === 'string' ? errorPayload.code : undefined,
          errorPayload.details,
        );
      }
      return unwrap<T>(payload);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('The request timed out or was cancelled.', 408, 'REQUEST_ABORTED');
      }
      if (error instanceof TypeError) {
        throw new ApiError('The service could not be reached.', 0, 'NETWORK_ERROR');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined;
  try {
    return await response.json();
  } catch {
    throw new ApiError('The service returned an invalid response.', response.status, 'INVALID_RESPONSE');
  }
}

function unwrap<T>(payload: unknown): T {
  if (isRecord(payload) && 'data' in payload) return payload.data as T;
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mergeSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (!first) return second;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) abort();
  first.addEventListener('abort', abort, { once: true });
  second.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
