import type { Complaint, ComplaintPriority, NewComplaintInput } from '../lib/domain';
import type { DepartmentContext } from '../auth/department';
import type { AuthApi } from './authTypes';

/** Authorized, citizen-safe data needed by the tracking UI. Swap implementation in ./index.ts. */
export interface ComplaintApi {
  readonly capabilities: ComplaintApiCapabilities;
  listMyComplaints(signal?: AbortSignal): Promise<Complaint[]>;
  getComplaint(publicId: string, signal?: AbortSignal): Promise<Complaint | null>;
  submitComplaint(input: NewComplaintInput, signal?: AbortSignal): Promise<Complaint>;
}

/** Read-only staff data. Visibility and authorization remain backend responsibilities. */
export interface StaffComplaint extends Complaint {
  departmentName: string;
  priority: ComplaintPriority | null;
}

export interface DepartmentApi {
  listDepartmentComplaints(context: DepartmentContext, signal?: AbortSignal): Promise<StaffComplaint[]>;
  getDepartmentComplaint(context: DepartmentContext, publicId: string, signal?: AbortSignal): Promise<StaffComplaint | null>;
}

/**
 * Platform-wide data is intentionally a separate capability. The current
 * mock adapter can expose its complete demo dataset to the protected admin
 * route; the HTTP adapter fails closed until a backend contract exists.
 */
export interface PlatformComplaint extends Complaint {
  departmentName: string | null;
  priority: ComplaintPriority | null;
}

export interface PlatformAnalyticsApi {
  listPlatformComplaints(signal?: AbortSignal): Promise<PlatformComplaint[]>;
}

export interface ComplaintApiCapabilities {
  /** True only when the adapter has an approved media-upload contract. */
  readonly photoAttachments: boolean;
}

export interface CivicFixApi extends ComplaintApi, DepartmentApi, PlatformAnalyticsApi, AuthApi {}
