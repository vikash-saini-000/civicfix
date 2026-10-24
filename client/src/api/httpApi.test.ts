import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { HttpCivicFixApi } from './httpApi';

const complaintPayload = {
  publicId: 'CF-2026-00001',
  title: 'Pothole near the bus stop',
  description: 'A deep pothole is making the road unsafe.',
  location: { lat: 13.0108, lng: 74.7943 },
  selectedCategory: 'roads',
  confirmedCategory: 'roads',
  department: 'Internal department',
  priority: 'P1',
  status: 'REPORTED',
  photoCount: 0,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  history: [{ status: 'REPORTED', at: '2026-10-24T10:00:00.000Z', note: 'A public update.' }],
};

describe('HttpCivicFixApi', () => {
  it('unwraps a typed JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [complaintPayload] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    const complaints = await api.listMyComplaints();
    expect(complaints).toMatchObject([{ publicId: 'CF-2026-00001', title: 'Pothole near the bus stop' }]);
    const [complaint] = complaints;
    expect(complaint).not.toHaveProperty('department');
    expect(complaint).not.toHaveProperty('priority');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/complaints',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('turns non-success JSON responses into ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Not allowed', code: 'FORBIDDEN' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.listMyComplaints()).rejects.toMatchObject<Partial<ApiError>>({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not allowed',
    });
  });

  it('rejects malformed complaint records instead of returning a false empty result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ publicId: 'CF-2026-00001' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.listMyComplaints()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
  });

  it('uses credentialed auth endpoints without persisting tokens client-side', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { user: { id: 'u1', email: 'citizen@example.test', displayName: 'Citizen', role: 'citizen' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'u1', email: 'citizen@example.test', displayName: 'Citizen', role: 'citizen' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    await expect(api.login({ email: 'citizen@example.test', password: 'not-stored' })).resolves.toMatchObject({
      user: { id: 'u1', role: 'citizen' },
    });
    await expect(api.getCurrentUser()).resolves.toMatchObject({ id: 'u1' });
    await expect(api.logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/v1/auth/login',
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ email: 'citizen@example.test', password: 'not-stored' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.example.test/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('sends the provisional text-and-location complaint contract as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ...complaintPayload, publicId: 'CF-2026-00420' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    await expect(api.submitComplaint({
      title: 'Pothole',
      description: 'A deep pothole near the bus stop.',
      location: { lat: 13.0108, lng: 74.7943 },
      selectedCategory: 'roads',
      photos: [],
    })).resolves.toMatchObject({ publicId: 'CF-2026-00420' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/complaints',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          title: 'Pothole',
          description: 'A deep pothole near the bus stop.',
          location: { lat: 13.0108, lng: 74.7943 },
          selectedCategory: 'roads',
          landmark: undefined,
        }),
      }),
    );
  });

  it('does not pretend photo upload is supported without an approved contract', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    await expect(api.submitComplaint({
      title: 'Pothole',
      description: 'A deep pothole near the bus stop.',
      location: { lat: 13.0108, lng: 74.7943 },
      selectedCategory: 'roads',
      photos: [new File(['photo'], 'issue.png', { type: 'image/png' })],
    })).rejects.toMatchObject({ status: 501, code: 'MEDIA_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
