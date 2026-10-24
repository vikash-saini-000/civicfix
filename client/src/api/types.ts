import type { Complaint, NewComplaintInput } from '../lib/domain';

/** What the UI needs from the backend. Swap the implementation in ./index.ts. */
export interface CivicFixApi {
  listMyComplaints(): Promise<Complaint[]>;
  getComplaint(publicId: string): Promise<Complaint | null>;
  submitComplaint(input: NewComplaintInput): Promise<Complaint>;
}
