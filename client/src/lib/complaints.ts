import { CATEGORIES, COMPLAINT_STATUSES, categoryLabel, type Complaint, type ComplaintStatus } from './domain';
import { ApiError } from '../api/errors';

export type ComplaintSort = 'updated-desc' | 'created-desc' | 'title-asc';

export function complaintLocationLabel(complaint: Pick<Complaint, 'location' | 'landmark' | 'address'>): string {
  const landmark = complaint.landmark?.trim();
  const address = complaint.address?.trim();
  if (landmark && address) return `${landmark} · ${address}`;
  if (landmark || address) return (landmark || address)!;
  const { lat, lng } = complaint.location ?? {};
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  return 'Location unavailable';
}

export function complaintSearchText(complaint: Complaint): string {
  return [
    complaint.publicId,
    complaint.title,
    complaint.description,
    complaint.selectedCategory,
    complaint.confirmedCategory,
    categoryLabel(complaint.confirmedCategory ?? complaint.selectedCategory),
    complaint.landmark,
    complaintLocationLabel(complaint),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function sortComplaints<T extends Complaint>(items: T[], sort: ComplaintSort): T[] {
  return [...items].sort((a, b) => {
    if (sort === 'title-asc') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    const field = sort === 'created-desc' ? 'createdAt' : 'updatedAt';
    return timestampValue(b[field]) - timestampValue(a[field]);
  });
}

export function countComplaintsByStatus(items: Complaint[], status: string): number {
  return items.filter((item) => item.status === status).length;
}

/** Options are derived from the authorized response, not from a privileged catalog. */
export function complaintStatusOptions(items: Complaint[]): ComplaintStatus[] {
  return [...new Set(items.map((item) => item.status))].sort((a, b) => statusOrder(a) - statusOrder(b));
}

/** Categories are also limited to values present in the authorized response. */
export function complaintCategoryOptions(items: Complaint[]): string[] {
  const knownOrder = new Map<string, number>(CATEGORIES.map((category, index) => [category.id, index]));
  return [...new Set(items.map((item) => item.confirmedCategory ?? item.selectedCategory).filter(Boolean) as string[])].sort(
    (a, b) => (knownOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (knownOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
  );
}

export function complaintLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'Your account is not allowed to view these complaints.';
  }
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
    return 'The complaint service could not be reached. Check your connection and try again.';
  }
  return 'We could not load your complaints. Please try again.';
}

export function isUsableComplaintId(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f\s/]/.test(value);
}

function timestampValue(value: string | undefined): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function statusOrder(status: ComplaintStatus): number {
  const index = COMPLAINT_STATUSES.indexOf(status as (typeof COMPLAINT_STATUSES)[number]);
  return index >= 0 ? index : COMPLAINT_STATUSES.length;
}
