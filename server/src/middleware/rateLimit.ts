import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Extra key part, e.g. the submitted email, combined with the client IP. */
  keyPart?: (req: Request) => string | undefined;
}

/**
 * Per-IP rate limiter for sensitive routes. Not applied globally.
 * In-memory store: fine for one process; use a shared store if the API runs on several instances.
 * Client IPs are only correct behind a proxy when TRUST_PROXY is set.
 */
export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const ip = ipKeyGenerator(req.ip ?? 'unknown');
      const extra = opts.keyPart?.(req);
      return extra ? `${ip}|${extra}` : ip;
    },
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 'Too many requests. Try again later.')),
  });
}
