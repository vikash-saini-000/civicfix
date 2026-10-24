import type { Complaint, ComplaintStatus } from './domain';
import { uniqueComplaints } from './analytics';

export interface ComplaintActivity {
  id: string;
  complaintId: string;
  complaintTitle: string;
  status: ComplaintStatus;
  at: string;
  note?: string;
}

/**
 * Flatten only the public history already returned by the citizen complaint
 * contract. This is an activity view, not a fabricated notification feed.
 */
export function buildComplaintActivity(complaints: Complaint[]): ComplaintActivity[] {
  const seen = new Set<string>();
  const activities: ComplaintActivity[] = [];

  for (const complaint of uniqueComplaints(complaints)) {
    for (const event of Array.isArray(complaint.history) ? complaint.history : []) {
      if (Number.isNaN(Date.parse(event.at))) continue;
      const id = `${complaint.publicId}\u0000${event.status}\u0000${event.at}\u0000${event.note ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      activities.push({
        id,
        complaintId: complaint.publicId,
        complaintTitle: complaint.title,
        status: event.status,
        at: event.at,
        ...(event.note ? { note: event.note } : {}),
      });
    }
  }

  return activities.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}
