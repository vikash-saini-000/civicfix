import { ApiError } from '../api/errors';
import { categoryLabel, getPriorityMeta, type ComplaintPriority } from './domain';
import { complaintCategoryOptions, complaintLocationLabel, complaintStatusOptions, sortComplaints, type ComplaintSort } from './complaints';
import type { StaffComplaint } from '../api/types';

export { complaintCategoryOptions, complaintStatusOptions, sortComplaints };
export type { ComplaintSort };

export function staffComplaintSearchText(complaint: StaffComplaint): string {
  return [
    complaint.publicId,
    complaint.title,
    complaint.description,
    complaint.selectedCategory,
    complaint.confirmedCategory,
    categoryLabel(complaint.confirmedCategory ?? complaint.selectedCategory),
    complaint.landmark,
    complaintLocationLabel(complaint),
    complaint.departmentName,
    complaint.priority,
    getPriorityMeta(complaint.priority ?? '').label,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function priorityOptions(items: StaffComplaint[]): ComplaintPriority[] {
  const order: ComplaintPriority[] = ['P1', 'P2', 'P3', 'P4'];
  return [...new Set(items.map((item) => item.priority).filter((priority): priority is ComplaintPriority => Boolean(priority)))].sort(
    (a, b) => (order.indexOf(a) === -1 ? order.length : order.indexOf(a)) - (order.indexOf(b) === -1 ? order.length : order.indexOf(b)) || a.localeCompare(b),
  );
}

export function staffLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'DEPARTMENT_API_NOT_CONFIGURED') {
    return 'Department complaint access is not available until the backend staff contract is implemented.';
  }
  if (error instanceof ApiError && error.code === 'DEPARTMENT_CONTEXT_REQUIRED') {
    return 'A trusted department name could not be established for this membership.';
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'Your account is not authorized to view this department data.';
  }
  if (error instanceof ApiError && (error.status === 0 || error.status === 408)) {
    return 'The department complaint service could not be reached. Check your connection and try again.';
  }
  return 'We could not load department complaints. Please try again.';
}
