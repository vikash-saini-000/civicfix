import type { ErrorRequestHandler, RequestHandler } from 'express';
import { safeError } from '../config/database.js';
import { AppError, type ErrorBody } from '../utils/errors.js';

/** Body-parser error types mapped to client-safe responses. */
const BODY_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  'entity.parse.failed': { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' },
  'entity.too.large': { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
  'encoding.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING', message: 'The request encoding is not supported.' },
  'charset.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING', message: 'The request charset is not supported.' },
  'request.aborted': { status: 400, code: 'REQUEST_ABORTED', message: 'The request was aborted.' },
};

const DB_UNAVAILABLE_NAMES = new Set(['MongooseServerSelectionError', 'MongoServerSelectionError', 'MongoNetworkError', 'MongoNotConnectedError']);

function isDatabaseUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    DB_UNAVAILABLE_NAMES.has(err.name) ||
    // Thrown by Mongoose when bufferCommands is off and the connection is down.
    /before initial connection is complete|Connection was force closed|client was closed/i.test(err.message)
  );
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}.`));
};

/** Last middleware. Sends exactly one safe JSON error; full details go to the server log only. */
export function errorHandler(opts: { exposeDetails: boolean }): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      // Too late to send an error body; let Express close the connection.
      req.log?.error({ err: safeError(err) }, 'error after response started');
      return next(err);
    }

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Try again later.';

    const bodyError = typeof err?.type === 'string' ? BODY_ERRORS[err.type] : undefined;
    if (err instanceof AppError) {
      ({ status, code, message } = err);
    } else if (bodyError) {
      ({ status, code, message } = bodyError);
    } else if (isDatabaseUnavailable(err)) {
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      message = 'The service is temporarily unavailable. Try again shortly.';
    }

    if (status >= 500) {
      req.log.error({ err: { ...safeError(err), stack: err instanceof Error ? err.stack : undefined } }, 'request failed');
      if (status === 500 && opts.exposeDetails && err instanceof Error) message = `${message} (${safeError(err).message})`;
    }

    if (status === 503) res.setHeader('Retry-After', '5');
    const body: ErrorBody = { error: { code, message, requestId: req.id } };
    res.status(status).json(body);
  };
}
