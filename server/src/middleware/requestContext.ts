import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
    }
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';
// Accept a caller's ID only if it is short and plain, so it can't inject into logs.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Assigns req.id (incoming X-Request-Id if valid, else a new UUID), echoes it back, and adds a child logger. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    req.id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

/** One log line per finished request: method, path (no query string), status, duration. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    req.log[level](
      { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, durationMs: Math.round(durationMs) },
      'request completed',
    );
  });
  next();
};
