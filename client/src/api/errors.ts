export class ApiError extends Error {
  readonly name = 'ApiError';

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ApiConfigError extends Error {
  readonly name = 'ApiConfigError';
}

export function getUserFacingApiMessage(error: unknown, fallback = 'We could not complete that request.') {
  if (error instanceof ApiError && error.code === 'BACKEND_REQUIRED') return error.message;
  if (error instanceof ApiError && error.status >= 500) {
    return 'The service is temporarily unavailable. Please try again.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'We could not find the requested civic record.';
  }
  if (error instanceof ApiError && error.status >= 400) {
    return error.message;
  }
  return fallback;
}
