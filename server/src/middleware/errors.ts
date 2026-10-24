import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { safeError } from '../config/database.js';
import { AppError, validationError, type ErrorBody, type ErrorDetail } from '../utils/errors.js';

/** Body-parser error types mapped to client-safe errors. */
const BODY_ERRORS: Record<string, () => AppError> = {
  'entity.parse.failed': () => new AppError('INVALID_JSON', 'The request body is not valid JSON.'),
  'entity.too.large': () => new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.'),
  'encoding.unsupported': () => new AppError('UNSUPPORTED_MEDIA_TYPE', 'The request encoding is not supported.'),
  'charset.unsupported': () => new AppError('UNSUPPORTED_MEDIA_TYPE', 'The request charset is not supported. Use UTF-8.'),
  'request.aborted': () => new AppError('VALIDATION_ERROR', 'The request was aborted before it was complete.'),
};

const SERVICE_UNAVAILABLE = () =>
  new AppError('SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again shortly.');

const DB_UNAVAILABLE_NAMES = new Set([
  'MongooseServerSelectionError',
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNotConnectedError',
]);

function isDatabaseUnavailable(err: Error): boolean {
  return (
    DB_UNAVAILABLE_NAMES.has(err.name) ||
    // Thrown by Mongoose when bufferCommands is off and the connection is down.
    /before initial connection is complete|Connection was force closed|client was closed/i.test(err.message)
  );
}

/** Maps any thrown value to a safe AppError, or null for an unexpected error (→ 500). */
function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  const bodyType = (err as { type?: unknown } | null)?.type;
  if (typeof bodyType === 'string' && BODY_ERRORS[bodyType]) return BODY_ERRORS[bodyType]();
  if (!(err instanceof Error)) return null;

  // Schema validation that slipped past request validation. Field paths and schema messages are safe.
  if (err instanceof mongoose.Error.ValidationError) {
    return validationError(
      Object.values(err.errors).map((e) => ({ field: e.path, issue: 'invalid', message: e.message.slice(0, 200) })),
    );
  }
  if (err instanceof mongoose.Error.CastError) {
    return validationError([{ field: err.path, issue: 'invalid_type', message: 'Value has the wrong format.' }]);
  }
  // Duplicate key. Report which fields clashed, never their values (could be an email).
  if ((err as { code?: unknown }).code === 11000) {
    const fields = Object.keys((err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {});
    const details: ErrorDetail[] = fields.map((field) => ({ field, issue: 'duplicate', message: 'This value is already in use.' }));
    return new AppError('CONFLICT', 'A record with the same unique value already exists.', details);
  }
  if (isDatabaseUnavailable(err)) return SERVICE_UNAVAILABLE();
  return null;
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}.`));
};

/**
 * Last middleware. Sends exactly one safe JSON error. Only 5xx errors are logged here (with stack);
 * 4xx outcomes appear once, in the request log line, with their error code.
 */
export function errorHandler(opts: { exposeDetails: boolean }): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      // Too late to send an error body; let Express close the connection.
      req.log?.error({ err: safeError(err) }, 'error after response started');
      return next(err);
    }

    let appError = toAppError(err);
    if (!appError) {
      req.log.error({ err: safeError(err, { stack: true }) }, 'unexpected error');
      const message = 'Something went wrong. Try again later.';
      appError = new AppError(
        'INTERNAL_ERROR',
        opts.exposeDetails && err instanceof Error ? `${message} (${safeError(err).message})` : message,
      );
    } else if (appError.status >= 500) {
      req.log.error({ err: safeError(err) }, 'request failed');
    }

    if (appError.code === 'SERVICE_UNAVAILABLE') res.setHeader('Retry-After', '5');
    res.locals.errorCode = appError.code;
    const body: ErrorBody = {
      success: false,
      error: { code: appError.code, message: appError.message, details: appError.details },
      requestId: req.id,
    };
    res.status(appError.status).json(body);
  };
}
