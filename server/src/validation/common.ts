// Reusable zod building blocks for route schemas.
import { z } from 'zod';
import { PUBLIC_ID_PATTERN } from '../models/Complaint.js';

/** MongoDB ObjectId as a 24-character hex string. */
export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid ID.');

/** Public complaint ID, e.g. CF-2026-00141. Case-insensitive input, normalized to upper case. */
export const complaintPublicId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PUBLIC_ID_PATTERN, 'Must be a complaint ID like CF-2026-00141.');

/** Trimmed, non-empty text with a maximum length. */
export const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/**
 * Whole number from a query string. Rejects signs, decimals, exponents, spaces and
 * values longer than 6 digits, so there is no float or overflow surprise.
 */
export const queryInt = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, 'Must be a whole number.')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** Route params for `/:id` routes. */
export const idParams = z.strictObject({ id: objectId });
