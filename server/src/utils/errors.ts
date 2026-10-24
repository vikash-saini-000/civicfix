/** Stable, machine-readable error codes. Clients may branch on these; don't rename them. */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

/** One problem with one input field. `field` is prefixed with its location, e.g. "body.title", "query.limit". */
export interface ErrorDetail {
  field: string;
  issue: string; // short machine code, e.g. "too_small", "invalid_type", "unrecognized_key"
  message: string;
}

/** An error whose code, message and details are safe to send to the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_CODES[code];
  }
}

export const validationError = (details: ErrorDetail[]) =>
  new AppError('VALIDATION_ERROR', 'The request contains invalid fields.', details);

export const notFoundError = (what = 'The requested resource') => new AppError('NOT_FOUND', `${what} was not found.`);

export interface ErrorBody {
  success: false;
  error: { code: ErrorCode; message: string; details: ErrorDetail[] };
  requestId: string;
}
