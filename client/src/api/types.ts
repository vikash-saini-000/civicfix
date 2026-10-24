import type { Complaint, NewComplaintInput } from '../lib/domain';
import type { AuthApi } from './authTypes';

/** What the UI needs from the backend. Swap the implementation in ./index.ts. */
export interface ComplaintApi {
  listMyComplaints(signal?: AbortSignal): Promise<Complaint[]>;
  getComplaint(publicId: string, signal?: AbortSignal): Promise<Complaint | null>;
  submitComplaint(input: NewComplaintInput, signal?: AbortSignal): Promise<Complaint>;
}

export interface CivicFixApi extends ComplaintApi, AuthApi {}
