import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Requires `Content-Type: application/json` on POST/PUT/PATCH requests that carry a body.
 * Without this, express.json() silently ignores other types and the body looks empty.
 * Routes that accept other types (e.g. future multipart uploads) must be mounted before this.
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
  if (BODY_METHODS.has(req.method) && hasBody && !req.is('application/json')) {
    return next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.'));
  }
  next();
};
