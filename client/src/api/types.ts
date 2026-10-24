import type { Complaint, ComplaintPriority, NewComplaintInput } from '../lib/domain';
import type { DepartmentContext } from '../auth/department';
import type { AuthApi } from './authTypes';
import type { OperationsApi } from './operationsTypes';

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
  departmentId?: string;
  priority: ComplaintPriority | null;
  /** Pseudonym shown to staff instead of the reporter's identity. */
  reporterAlias?: string;
  spamCheck?: { score: number; signals: string[] } | null;
}

export interface DepartmentApi {
  listDepartmentComplaints(context: DepartmentContext, signal?: AbortSignal): Promise<StaffComplaint[]>;
  getDepartmentComplaint(context: DepartmentContext, publicId: string, signal?: AbortSignal): Promise<StaffComplaint | null>;
}

/** Platform-wide complaint list (GET /complaints?scope=all, platform admins only). */
export interface PlatformComplaint extends Complaint {
  departmentName: string | null;
  priority: ComplaintPriority | null;
}

export interface PlatformAnalyticsApi {
  listPlatformComplaints(signal?: AbortSignal): Promise<PlatformComplaint[]>;
}

export interface ComplaintApiCapabilities {
  /** True when the adapter can upload evidence files. */
  readonly photoAttachments: boolean;
  /** True when the adapter talks to the real backend workflows (work orders, review, notifications). */
  readonly operations?: boolean;
}

export interface CivicFixApi extends ComplaintApi, DepartmentApi, PlatformAnalyticsApi, AuthApi, OperationsApi {}
