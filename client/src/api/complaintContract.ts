import type { CategoryId, Complaint, ComplaintStatus, StatusEvent } from '../lib/domain';
import { ApiError } from './errors';

/**
 * Normalize the citizen-safe complaint shape at the API boundary.
 *
 * The HTTP endpoint is still provisional, so the UI must not pass arbitrary
 * response objects through to citizen pages. Internal assignment and priority
 * fields are intentionally not copied here.
 */
export function parseComplaintList(value: unknown): Complaint[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(parseComplaint);
}

export function parseComplaint(value: unknown): Complaint {
  if (!isRecord(value)) throw invalidResponse();

  const publicId = requiredString(value.publicId);
  const title = requiredString(value.title);
  const description = requiredString(value.description);
  const status = requiredString(value.status) as ComplaintStatus;
  const createdAt = requiredTimestamp(value.createdAt);
  const updatedAt = requiredTimestamp(value.updatedAt);
  const location = parseLocation(value.location);

  if (!publicId || !title || !description || !createdAt || !updatedAt || !location) throw invalidResponse();

  return {
    publicId,
    title,
    description,
    location,
    ...(optionalString(value.landmark) ? { landmark: optionalString(value.landmark) } : {}),
    selectedCategory: parseCategory(value.selectedCategory),
    confirmedCategory: parseCategory(value.confirmedCategory),
    status,
    ...(optionalNonNegativeInteger(value.photoCount) !== undefined
      ? { photoCount: optionalNonNegativeInteger(value.photoCount) }
      : {}),
    createdAt,
    updatedAt,
    history: parseHistory(value.history),
  };
}

function parseHistory(value: unknown): StatusEvent[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidResponse();

  return value.map((event) => {
    if (!isRecord(event)) throw invalidResponse();
    const status = requiredString(event.status);
    const at = requiredTimestamp(event.at);
    if (!status || !at) throw invalidResponse();
    const note = optionalString(event.note);
    return { status: status as ComplaintStatus, at, ...(note ? { note } : {}) };
  });
}

function parseCategory(value: unknown): CategoryId | null {
  if (value === null || value === undefined || value === '') return null;
  return isCategory(value) ? value : null;
}

function parseLocation(value: unknown): Complaint['location'] | null {
  if (!isRecord(value) || typeof value.lat !== 'number' || typeof value.lng !== 'number') return null;
  if (!Number.isFinite(value.lat) || !Number.isFinite(value.lng)) return null;
  if (value.lat < -90 || value.lat > 90 || value.lng < -180 || value.lng > 180) return null;
  return { lat: value.lat, lng: value.lng };
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  const parsed = requiredString(value);
  return parsed ?? undefined;
}

function requiredTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isCategory(value: unknown): value is CategoryId {
  return value === 'roads' || value === 'garbage' || value === 'streetlight' || value === 'water' || value === 'drainage' || value === 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidResponse(): ApiError {
  return new ApiError('The complaint service returned an invalid response.', 502, 'INVALID_RESPONSE');
}
