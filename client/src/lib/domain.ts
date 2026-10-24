// Shapes follow docs/CivicFixFullDetails.pdf (sections 5 and 6).
// They are a client-side draft until the backend API contracts are finalised.

export const COMPLAINT_STATUSES = [
  'REPORTED',
  'UNDER_REVIEW',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'BLOCKED',
  'RESOLUTION_SUBMITTED',
  'VERIFICATION_REQUIRED',
  'RESOLVED',
  'CLOSED',
  'REJECTED',
] as const;
export type KnownComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
/** Backend values may gain a new status before this client is updated. */
export type ComplaintStatus = KnownComplaintStatus | (string & {});

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
/** Backend values may gain a new priority before this client is updated. */
export type ComplaintPriority = Priority | (string & {});

export const CATEGORIES = [
  { id: 'roads', label: 'Roads and potholes' },
  { id: 'garbage', label: 'Garbage and sanitation' },
  { id: 'streetlight', label: 'Streetlights' },
  { id: 'water', label: 'Water supply and leaks' },
  { id: 'drainage', label: 'Drainage and sewage' },
  { id: 'other', label: 'Something else' },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]['id'];

export function categoryLabel(id: string | null | undefined): string {
  if (!id) return 'Not chosen yet';
  return CATEGORIES.find((c) => c.id === id)?.label ?? 'Category unavailable';
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export function isValidGeoPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return Boolean(
    point &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lng) &&
      point.lat >= -90 &&
      point.lat <= 90 &&
      point.lng >= -180 &&
      point.lng <= 180,
  );
}

export interface StatusEvent {
  status: ComplaintStatus;
  at: string; // ISO timestamp
  note?: string; // citizen-facing note only
}

export interface FollowUp {
  questions: string[];
  answers: string[];
  askedAt: string;
  answeredAt: string | null;
}

export interface Complaint {
  publicId: string;
  title: string;
  description: string;
  location: GeoPoint;
  landmark?: string;
  /** Street address looked up by the server (OpenStreetMap) when the complaint was submitted. */
  address?: string | null;
  selectedCategory: CategoryId | null;
  confirmedCategory: CategoryId | null;
  status: ComplaintStatus;
  photoCount?: number;
  /** Set by the HTTP adapter when some photos could not be uploaded after the report was saved. */
  photoUploadFailures?: number;
  createdAt: string;
  updatedAt: string;
  history?: StatusEvent[];
  /** Fields below come from the backend complaint view (docs/api/COMPLAINTS.md). */
  rejectionReason?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  followUp?: FollowUp | null;
  duplicateOf?: { publicId: string; status: ComplaintStatus; linkedAt: string } | null;
  linkedReportCount?: number;
  /** UI hint only; the server re-checks every action. */
  allowedActions?: string[];
}

export interface NewComplaintInput {
  title: string;
  description: string;
  location: GeoPoint;
  landmark?: string;
  selectedCategory: CategoryId | null;
  photos: File[];
}

type Tone = 'gray' | 'blue' | 'cyan' | 'purple' | 'green' | 'yellow' | 'red';

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** Plain-language explanation shown to citizens. */
  citizenText: string;
}

export const STATUS_META: Record<KnownComplaintStatus, StatusMeta> = {
  REPORTED: {
    label: 'Reported',
    tone: 'gray',
    citizenText: 'We have received your complaint.',
  },
  UNDER_REVIEW: {
    label: 'Under review',
    tone: 'cyan',
    citizenText: 'We are checking the details and looking for similar reports nearby.',
  },
  ASSIGNED: {
    label: 'Assigned',
    tone: 'blue',
    citizenText: 'A department team has been given this work.',
  },
  ACCEPTED: {
    label: 'Accepted',
    tone: 'blue',
    citizenText: 'The assigned team has accepted the work.',
  },
  IN_PROGRESS: {
    label: 'In progress',
    tone: 'blue',
    citizenText: 'Work has started on site.',
  },
  BLOCKED: {
    label: 'On hold',
    tone: 'yellow',
    citizenText: 'Work is paused. The team has recorded the reason and the next step.',
  },
  RESOLUTION_SUBMITTED: {
    label: 'Fix submitted',
    tone: 'purple',
    citizenText: 'The team says the work is done and has sent evidence. It is being checked.',
  },
  VERIFICATION_REQUIRED: {
    label: 'Being verified',
    tone: 'yellow',
    citizenText: 'The evidence needs a closer look by a manager before we close this.',
  },
  RESOLVED: {
    label: 'Resolved',
    tone: 'green',
    citizenText: 'The fix has been checked and confirmed.',
  },
  CLOSED: {
    label: 'Closed',
    tone: 'gray',
    citizenText: 'This complaint is complete.',
  },
  REJECTED: {
    label: 'Rejected',
    tone: 'red',
    citizenText: 'This complaint could not be taken forward. The reason is shown below.',
  },
};

const UNKNOWN_STATUS_META: StatusMeta = {
  label: 'Status update',
  tone: 'gray',
  citizenText: 'The complaint has a status update that is not described in this version of CivicFix.',
};

export function getStatusMeta(status: string): StatusMeta {
  return hasOwn(STATUS_META, status) ? STATUS_META[status as KnownComplaintStatus] : UNKNOWN_STATUS_META;
}

export function isKnownComplaintStatus(status: string): status is KnownComplaintStatus {
  return hasOwn(STATUS_META, status);
}

export const PRIORITY_META: Record<Priority, { label: string; description: string }> = {
  P1: { label: 'P1 Urgent', description: 'Possible danger to people. Handled first.' },
  P2: { label: 'P2 High', description: 'Serious problem affecting many people.' },
  P3: { label: 'P3 Medium', description: 'Needs fixing soon.' },
  P4: { label: 'P4 Low', description: 'Minor problem.' },
};

const UNKNOWN_PRIORITY_META = {
  label: 'Priority update',
  description: 'The complaint has a priority value that is not described in this version of CivicFix.',
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function getPriorityMeta(priority: string): { label: string; description: string } {
  return hasOwn(PRIORITY_META, priority) ? PRIORITY_META[priority as Priority] : UNKNOWN_PRIORITY_META;
}

export function formatDateTime(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Date unavailable';
  return DATE_TIME_FORMATTER.format(date);
}

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(record, key);
}
