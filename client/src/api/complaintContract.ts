import type { CategoryId, Complaint, ComplaintStatus, FollowUp, StatusEvent } from '../lib/domain';
import { ApiError } from './errors';
import type { PlatformComplaint, StaffComplaint } from './types';

/**
 * Normalize the backend complaint view (docs/api/COMPLAINTS.md) at the API boundary, so pages never
 * receive arbitrary response objects. Citizen views never copy department or priority fields.
 */
export function parseComplaintList(value: unknown): Complaint[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(parseComplaint);
}

export function parseComplaint(value: unknown): Complaint {
  const record = unwrapComplaint(value);

  const publicId = requiredString(record.publicId);
  const title = requiredString(record.title);
  const description = requiredString(record.description);
  const status = requiredString(record.status) as ComplaintStatus;
  const createdAt = requiredTimestamp(record.createdAt);
  const updatedAt = requiredTimestamp(record.updatedAt);
  const location = parseLocation(record.location);

  if (!publicId || !title || !description || !createdAt || !updatedAt || !location) throw invalidResponse();

  const complaint: Complaint = {
    publicId,
    title,
    description,
    location,
    ...(optionalString(record.landmark) ? { landmark: optionalString(record.landmark) } : {}),
    ...(optionalString(record.address) ? { address: optionalString(record.address) } : {}),
    selectedCategory: parseCategory(record.selectedCategory),
    confirmedCategory: parseCategory(record.confirmedCategory),
    status,
    ...(optionalNonNegativeInteger(record.photoCount) !== undefined
      ? { photoCount: optionalNonNegativeInteger(record.photoCount) }
      : {}),
    createdAt,
    updatedAt,
    // The backend calls it statusHistory; older drafts used history.
    history: parseHistory(record.statusHistory ?? record.history),
    rejectionReason: optionalString(record.rejectionReason) ?? null,
    resolvedAt: requiredTimestamp(record.resolvedAt),
    closedAt: requiredTimestamp(record.closedAt),
    followUp: parseFollowUp(record.followUp),
    duplicateOf: parseDuplicateOf(record.duplicateOf),
    linkedReportCount: optionalNonNegativeInteger(record.linkedReportCount) ?? 0,
    allowedActions: Array.isArray(record.allowedActions) ? record.allowedActions.filter((a): a is string => typeof a === 'string') : [],
  };
  return complaint;
}

/** Staff view: adds department, priority and the reporter pseudonym. */
export function parseStaffComplaint(value: unknown): StaffComplaint {
  const record = unwrapComplaint(value);
  const base = parseComplaint(record);
  const department = isRecord(record.department) ? optionalString(record.department.name) : undefined;
  const reporter = isRecord(record.reporter) ? optionalString(record.reporter.alias) : undefined;
  const spam = isRecord(record.spamCheck) && typeof record.spamCheck.score === 'number'
    ? { score: record.spamCheck.score, signals: Array.isArray(record.spamCheck.signals) ? record.spamCheck.signals.filter((s): s is string => typeof s === 'string') : [] }
    : null;
  return {
    ...base,
    departmentName: department ?? 'Not routed yet',
    ...(isRecord(record.department) && typeof record.department.id === 'string' ? { departmentId: record.department.id } : {}),
    priority: optionalString(record.priority) ?? null,
    ...(reporter ? { reporterAlias: reporter } : {}),
    spamCheck: spam,
  };
}

export function parsePlatformComplaint(value: unknown): PlatformComplaint {
  const record = unwrapComplaint(value);
  const staff = parseStaffComplaint(record);
  const departmentName = isRecord(record.department) ? optionalString(record.department.name) ?? null : null;
  return { ...staff, departmentName };
}

/** Single-resource responses wrap the complaint as `{ complaint: {...} }`. */
function unwrapComplaint(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse();
  if (isRecord(value.complaint) && !('publicId' in value)) return value.complaint;
  return value;
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

function parseFollowUp(value: unknown): FollowUp | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null;
  const askedAt = requiredTimestamp(value.askedAt);
  if (!askedAt) return null;
  return {
    questions: value.questions.filter((q): q is string => typeof q === 'string'),
    answers: Array.isArray(value.answers) ? value.answers.filter((a): a is string => typeof a === 'string') : [],
    askedAt,
    answeredAt: requiredTimestamp(value.answeredAt),
  };
}

function parseDuplicateOf(value: unknown): Complaint['duplicateOf'] {
  if (!isRecord(value)) return null;
  const publicId = requiredString(value.publicId);
  const linkedAt = requiredTimestamp(value.linkedAt);
  if (!publicId || !linkedAt) return null;
  return { publicId, status: (requiredString(value.status) ?? 'UNDER_REVIEW') as ComplaintStatus, linkedAt };
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
