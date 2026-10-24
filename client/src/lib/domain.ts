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
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export const CATEGORIES = [
  { id: 'roads', label: 'Roads and potholes' },
  { id: 'garbage', label: 'Garbage and sanitation' },
  { id: 'streetlight', label: 'Streetlights' },
  { id: 'water', label: 'Water supply and leaks' },
  { id: 'drainage', label: 'Drainage and sewage' },
  { id: 'other', label: 'Something else' },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]['id'];

export function categoryLabel(id: CategoryId | null | undefined): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? 'Not chosen yet';
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface StatusEvent {
  status: ComplaintStatus;
  at: string; // ISO timestamp
  note?: string; // citizen-facing note only
}

export interface Complaint {
  publicId: string;
  title: string;
  description: string;
  location: GeoPoint;
  landmark?: string;
  selectedCategory: CategoryId | null;
  confirmedCategory: CategoryId | null;
  department?: string;
  priority: Priority | null;
  status: ComplaintStatus;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
  history: StatusEvent[];
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

interface StatusMeta {
  label: string;
  tone: Tone;
  /** Plain-language explanation shown to citizens. */
  citizenText: string;
}

export const STATUS_META: Record<ComplaintStatus, StatusMeta> = {
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

/** Main path shown as steps in the tracker. Other statuses appear as alerts. */
export const TRACKER_STEPS: { label: string; statuses: ComplaintStatus[] }[] = [
  { label: 'Reported', statuses: ['REPORTED'] },
  { label: 'Under review', statuses: ['UNDER_REVIEW'] },
  { label: 'Assigned', statuses: ['ASSIGNED', 'ACCEPTED'] },
  { label: 'In progress', statuses: ['IN_PROGRESS', 'BLOCKED'] },
  { label: 'Fix submitted', statuses: ['RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'] },
  { label: 'Resolved', statuses: ['RESOLVED', 'CLOSED'] },
];

export const PRIORITY_META: Record<Priority, { label: string; description: string }> = {
  P1: { label: 'P1 Urgent', description: 'Possible danger to people. Handled first.' },
  P2: { label: 'P2 High', description: 'Serious problem affecting many people.' },
  P3: { label: 'P3 Medium', description: 'Needs fixing soon.' },
  P4: { label: 'P4 Low', description: 'Minor problem.' },
};

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
