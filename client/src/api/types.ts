import type { Complaint, NewComplaintInput } from '../lib/domain';
import type { AuthApi } from './authTypes';

/** Authorized, citizen-safe data needed by the tracking UI. Swap implementation in ./index.ts. */
export interface ComplaintApi {
  readonly capabilities: ComplaintApiCapabilities;
  listMyComplaints(signal?: AbortSignal): Promise<Complaint[]>;
  getComplaint(publicId: string, signal?: AbortSignal): Promise<Complaint | null>;
  submitComplaint(input: NewComplaintInput, signal?: AbortSignal): Promise<Complaint>;
}

export interface ComplaintApiCapabilities {
  /** True only when the adapter has an approved media-upload contract. */
  readonly photoAttachments: boolean;
}

export interface CivicFixApi extends ComplaintApi, AuthApi {}
