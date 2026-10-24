import type { RequestHandler } from 'express';
import { z } from 'zod';
import { validationError, type ErrorDetail } from '../utils/errors.js';

type Location = 'params' | 'query' | 'body' | 'headers';
type Schemas = Partial<Record<Location, z.ZodType>>;

/** Parsed, validated input. Handlers read from here, never from req.body / req.query directly. */
export interface Validated {
  params?: unknown;
  query?: unknown;
  body?: unknown;
  headers?: unknown;
}

declare global {
  namespace Express {
    interface Request {
      validated: Validated;
    }
  }
}

/** Converts zod issues into client-safe field details, e.g. { field: "body.title", issue: "too_small" }. */
export function toDetails(location: Location, error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    const base = [location, ...issue.path.map(String)];
    // Report each unknown key as its own field so the client can see exactly what to remove.
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: [...base, key].join('.'),
        issue: 'unrecognized_key',
        message: 'This field is not allowed.',
      }));
    }
    return [{ field: base.join('.'), issue: issue.code, message: issue.message }];
  });
}

/**
 * Validates params, query, body and/or headers with zod schemas. On success the parsed values
 * are stored on `req.validated`; on failure all problems are reported together as one 400.
 * Object schemas should be strict (see validation/common.ts) so unexpected fields are rejected, not dropped.
 */
export function validate(schemas: Schemas): RequestHandler {
  const order: Location[] = ['params', 'query', 'headers', 'body'];
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const out: Validated = {};
    for (const location of order) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(location === 'body' ? (req.body ?? {}) : req[location]);
      if (result.success) out[location] = result.data;
      else details.push(...toDetails(location, result.error));
    }
    if (details.length > 0) return next(validationError(details));
    req.validated = { ...req.validated, ...out };
    next();
  };
}

/** Typed accessor: `const { page } = input<PaginationQuery>(req, 'query')`. */
export function input<T>(req: Express.Request, location: Location): T {
  return req.validated?.[location] as T;
}
