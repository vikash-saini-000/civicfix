import { describe, expect, it } from 'vitest';
import { createMockApi } from './mockApi';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('mock CivicFix API', () => {
  it('returns seeded data and reads a submitted complaint back through the same contract', async () => {
    const api = createMockApi({
      now: () => new Date('2026-10-24T12:00:00.000Z'),
      storage: new MemoryStorage(),
      latencyMs: 0,
      reviewDelayMs: 60_000,
    });

    const before = await api.listMyComplaints();
    expect(before).toHaveLength(3);

    const created = await api.submitComplaint({
      title: 'Broken public tap',
      description: 'The tap near the park has been leaking since yesterday.',
      location: { lat: 13.01, lng: 74.79 },
      selectedCategory: 'water',
      photos: [],
    });

    await expect(api.getComplaint(created.publicId)).resolves.toMatchObject({
      publicId: created.publicId,
      status: 'REPORTED',
      title: 'Broken public tap',
      photoCount: 0,
    });
  });
});
