import { z } from 'zod';
import { queryInt } from './common.js';

export const PAGINATION_DEFAULTS = { page: 1, limit: 20 } as const;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 10_000;

/** `?page=&limit=` with defaults. Use `.extend()` to add list-specific filters, then keep it strict. */
export const paginationQuery = z.strictObject({
  page: queryInt(1, MAX_PAGE).default(PAGINATION_DEFAULTS.page),
  limit: queryInt(1, MAX_LIMIT).default(PAGINATION_DEFAULTS.limit),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

/**
 * `?sort=field` (ascending) or `?sort=-field` (descending), limited to an allowlist.
 * Returns a Mongo sort object, e.g. { createdAt: -1 }.
 */
export function sortQuery<const F extends string>(fields: readonly [F, ...F[]], fallback: `${'' | '-'}${F}`) {
  const allowed = new Set<string>(fields);
  return z
    .string()
    .regex(/^-?[A-Za-z]+$/, 'Must be a field name, optionally prefixed with "-".')
    .refine((s) => allowed.has(s.replace(/^-/, '')), `Must be one of: ${fields.join(', ')} (prefix "-" for descending).`)
    .default(fallback)
    .transform((s) => ({ [s.replace(/^-/, '')]: s.startsWith('-') ? -1 : 1 }) as Record<F, 1 | -1>);
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

/** Values for Mongoose `.skip()` / `.limit()`. */
export const toSkipLimit = ({ page, limit }: PaginationQuery) => ({ skip: (page - 1) * limit, limit });

/** `meta.pagination` for list responses. */
export function paginationMeta({ page, limit }: PaginationQuery, total: number): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return { page, limit, total, totalPages, hasNextPage: page < totalPages };
}
