import { describe, expect, it } from 'vitest';
import type { Complaint } from './domain';
import { buildComplaintAnalytics, buildPlatformAnalytics, dateRangeForPreset, filterComplaintsByDate, resolutionDurationHours, uniqueComplaints, validateDateRange } from './analytics';

function complaint(overrides: Partial<Complaint> = {}): Complaint {
  return {
    publicId: 'CF-2026-00001',
    title: 'Pothole near the bus stop',
    description: 'A deep pothole is affecting traffic.',
    location: { lat: 13, lng: 74 },
    selectedCategory: 'roads',
    confirmedCategory: 'roads',
    status: 'REPORTED',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('complaint analytics', () => {
  it('deduplicates records before calculating counts', () => {
    const duplicate = complaint({ publicId: 'CF-2026-00001', status: 'IN_PROGRESS' });
    const result = buildComplaintAnalytics([complaint(), duplicate, complaint({ publicId: 'CF-2026-00002', status: 'IN_PROGRESS', selectedCategory: null, confirmedCategory: null })]);

    expect(uniqueComplaints([complaint(), duplicate])).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.statusCounts.REPORTED).toBe(1);
    expect(result.statusCounts.IN_PROGRESS).toBe(1);
    expect(result.categoryCounts).toEqual(expect.arrayContaining([
      { id: 'roads', label: 'Roads and potholes', count: 1 },
      { id: 'uncategorized', label: 'Not categorized', count: 1 },
    ]));
  });

  it('calculates resolution duration only from valid history timestamps', () => {
    const resolved = complaint({
      publicId: 'CF-2026-00003',
      status: 'RESOLVED',
      history: [
        { status: 'REPORTED', at: '2026-10-20T00:00:00.000Z' },
        { status: 'RESOLVED', at: '2026-10-22T00:00:00.000Z' },
      ],
    });
    const invalid = complaint({
      publicId: 'CF-2026-00004',
      status: 'CLOSED',
      createdAt: 'not-a-date',
      history: [{ status: 'CLOSED', at: '2026-10-22T00:00:00.000Z' }],
    });

    expect(resolutionDurationHours(resolved)).toBe(48);
    expect(resolutionDurationHours(invalid)).toBeNull();
    expect(buildComplaintAnalytics([resolved, invalid]).resolutionDuration).toEqual({ averageHours: 48, medianHours: 48, sampleSize: 1 });
  });

  it('keeps zero and unavailable values distinct', () => {
    const result = buildComplaintAnalytics([]);

    expect(result.total).toBe(0);
    expect(result.activeOrPendingCount).toBe(0);
    expect(result.resolvedOrClosedCount).toBe(0);
    expect(result.resolutionDuration).toEqual({ averageHours: null, medianHours: null, sampleSize: 0 });
  });

  it('filters a complete platform dataset and groups departments and trends', () => {
    const range = dateRangeForPreset('7', new Date('2026-10-24T12:00:00.000Z'));
    const result = buildPlatformAnalytics([
      { ...complaint({ publicId: 'CF-2026-00005', createdAt: '2026-10-24T01:00:00.000Z', status: 'IN_PROGRESS' }), departmentName: 'Roads', priority: 'P2' },
      { ...complaint({ publicId: 'CF-2026-00006', createdAt: '2026-10-01T01:00:00.000Z', status: 'CLOSED' }), departmentName: 'Waste', priority: 'P3' },
      { ...complaint({ publicId: 'CF-2026-00007', createdAt: '2026-09-01T01:00:00.000Z' }), departmentName: null, priority: null },
    ], range);

    expect(result.total).toBe(1);
    expect(result.departmentWorkload).toEqual([{ name: 'Roads', total: 1, unresolved: 1, resolvedOrClosed: 0 }]);
    expect(result.trendBucket).toBe('day');
    expect(result.trend.some((point) => point.count === 1)).toBe(true);
  });

  it('filters before deduplicating so an in-range duplicate is not hidden', () => {
    const range = dateRangeForPreset('7', new Date('2026-10-24T12:00:00.000Z'));
    const result = buildPlatformAnalytics([
      {
        ...complaint({ publicId: 'CF-2026-00008', createdAt: '2026-10-01T01:00:00.000Z', status: 'REPORTED' }),
        departmentName: 'Roads',
        priority: 'P2',
      },
      {
        ...complaint({ publicId: 'cf-2026-00008', createdAt: '2026-10-24T01:00:00.000Z', status: 'CLOSED' }),
        departmentName: 'Roads',
        priority: 'P2',
      },
    ], range);

    expect(result.total).toBe(1);
    expect(result.statusCounts.CLOSED).toBe(1);
    expect(result.departmentWorkload).toEqual([{ name: 'Roads', total: 1, unresolved: 0, resolvedOrClosed: 1 }]);
  });

  it('reports invalid submission timestamps separately from zero metrics', () => {
    const result = buildPlatformAnalytics([
      { ...complaint({ publicId: 'CF-2026-00009', createdAt: 'not-a-date' }), departmentName: null, priority: null },
    ], { from: null, to: null });

    expect(result.total).toBe(0);
    expect(result.invalidCreatedAtCount).toBe(1);
    expect(result.resolutionDuration.averageHours).toBeNull();
  });

  it('rejects incomplete or reversed custom date ranges', () => {
    expect(validateDateRange({ from: null, to: '2026-10-24' })).toBe('Choose both a start date and an end date.');
    expect(validateDateRange({ from: '2026-10-25', to: '2026-10-24' })).toBe('The start date must be on or before the end date.');
    expect(validateDateRange({ from: '2026-02-30', to: '2026-03-01' })).toBe('Enter valid calendar dates.');
  });

  it('returns no records for an invalid direct date-filter request', () => {
    expect(filterComplaintsByDate([complaint()], { from: '2026-02-30', to: '2026-03-01' })).toEqual([]);
  });
});
