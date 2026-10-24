import { describe, expect, it } from 'vitest';
import type { Complaint } from './domain';
import { buildComplaintActivity } from './activity';

function complaint(overrides: Partial<Complaint> = {}): Complaint {
  return {
    publicId: 'CF-2026-00001',
    title: 'Deep pothole near the bus stop',
    description: 'A deep pothole is affecting traffic.',
    location: { lat: 13, lng: 74 },
    selectedCategory: 'roads',
    confirmedCategory: 'roads',
    status: 'IN_PROGRESS',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('complaint activity', () => {
  it('flattens authorized public history, removes duplicates, and sorts newest first', () => {
    const firstEvent = { status: 'REPORTED' as const, at: '2026-10-20T00:00:00.000Z' };
    const secondEvent = { status: 'IN_PROGRESS' as const, at: '2026-10-24T00:00:00.000Z', note: 'Crew is on site.' };

    expect(buildComplaintActivity([
      complaint({ history: [firstEvent, secondEvent, secondEvent, { status: 'FUTURE_STATUS', at: 'invalid' }] }),
      complaint({ publicId: 'cf-2026-00001', history: [firstEvent] }),
      complaint({ publicId: 'CF-2026-00002', title: 'Streetlight', history: [{ status: 'REPORTED', at: '2026-10-23T00:00:00.000Z' }] }),
    ])).toEqual([
      expect.objectContaining({ complaintId: 'CF-2026-00001', status: 'IN_PROGRESS', note: 'Crew is on site.' }),
      expect.objectContaining({ complaintId: 'CF-2026-00002', status: 'REPORTED' }),
      expect.objectContaining({ complaintId: 'CF-2026-00001', status: 'REPORTED' }),
    ]);
  });

  it('returns an empty activity list when complaints contain no public history', () => {
    expect(buildComplaintActivity([complaint(), complaint({ publicId: 'CF-2026-00002', history: [] })])).toEqual([]);
  });
});
